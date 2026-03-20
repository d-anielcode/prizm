import { supabase } from '@/lib/supabase'
import { ConfidenceBadge } from '@/components/ConfidenceBadge'
import Link from 'next/link'
import type { Prop, StatType, Direction } from '@/types'

export const revalidate = 0

// ---- Types ----

interface GameLog {
  player_name: string
  game_date: string
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  fg3m: number
  pra: number
}

interface StreakEntry {
  prop: Prop
  streak: number
}

// ---- Helpers ----

function getStatValue(log: GameLog, statType: StatType): number {
  switch (statType) {
    case 'points':        return log.points
    case 'rebounds':      return log.rebounds
    case 'assists':       return log.assists
    case 'steals':        return log.steals
    case 'blocks':        return log.blocks
    case 'three_pointers': return log.fg3m
    case 'pra':           return log.pra
    default:              return 0
  }
}

function consecutiveHits(
  logs: GameLog[],
  statType: StatType,
  line: number,
  direction: Direction,
): number {
  // logs are already sorted newest first
  let streak = 0
  for (const log of logs) {
    const val = getStatValue(log, statType)
    const hit = direction === 'over' ? val > line : val < line
    if (hit) streak++
    else break
  }
  return streak
}

function deduplicateProps(props: Prop[]): Prop[] {
  const best = new Map<string, Prop>()
  for (const prop of props) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.line}`
    const existing = best.get(key)
    if (!existing || (prop.confidence_score ?? 0) > (existing.confidence_score ?? 0)) {
      best.set(key, prop)
    }
  }
  return [...best.values()].sort(
    (a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0),
  )
}

function formatGameTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  } as Intl.DateTimeFormatOptions)
}

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

// ---- Data fetching ----

async function getData(): Promise<StreakEntry[]> {
  const now = new Date().toISOString()

  // 1. Fetch all scored upcoming props
  const allRows: Prop[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('props')
      .select('*')
      .or(`commence_time.is.null,commence_time.gt.${now}`)
      .order('confidence_score', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1)
    if (error) { console.error('[trends] props error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...(data as Prop[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  const props = deduplicateProps(allRows)

  // 2. Get unique player names
  const playerNames = [...new Set(props.map((p) => p.player_name))]

  // 3. Fetch all game logs for those players
  const logsMap = new Map<string, GameLog[]>()

  // Fetch in batches to avoid URL length limits
  const PLAYER_BATCH = 50
  for (let i = 0; i < playerNames.length; i += PLAYER_BATCH) {
    const batch = playerNames.slice(i, i + PLAYER_BATCH)
    const { data: logRows, error } = await supabase
      .from('player_game_logs')
      .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra')
      .in('player_name', batch)
      .order('game_date', { ascending: false })

    if (error) { console.error('[trends] logs error:', error.message); continue }

    for (const row of (logRows ?? [])) {
      const name = String(row.player_name)
      if (!logsMap.has(name)) logsMap.set(name, [])
      logsMap.get(name)!.push({
        player_name: name,
        game_date: String(row.game_date),
        points:   Number(row.points   ?? 0),
        rebounds: Number(row.rebounds  ?? 0),
        assists:  Number(row.assists   ?? 0),
        steals:   Number(row.steals    ?? 0),
        blocks:   Number(row.blocks    ?? 0),
        fg3m:     Number(row.fg3m      ?? 0),
        pra:      Number(row.pra       ?? 0),
      })
    }
  }

  // 4. Compute streaks
  const entries: StreakEntry[] = []
  for (const prop of props) {
    const logs = logsMap.get(prop.player_name) ?? []
    if (logs.length === 0) continue
    const streak = consecutiveHits(logs, prop.stat_type, prop.line, prop.direction)
    if (streak >= 5) {
      entries.push({ prop, streak })
    }
  }

  // Step 1: dedupe exact duplicates (same player+stat+line+direction)
  const exactDedup = new Map<string, StreakEntry>()
  for (const entry of entries) {
    const key = `${entry.prop.player_name}|${entry.prop.stat_type}|${entry.prop.line}|${entry.prop.direction}`
    const existing = exactDedup.get(key)
    if (!existing || entry.streak > existing.streak) {
      exactDedup.set(key, entry)
    }
  }

  // Step 2: per player+stat, keep only the best-streaking line
  const bestPerStat = new Map<string, StreakEntry>()
  for (const entry of exactDedup.values()) {
    const key = `${entry.prop.player_name}|${entry.prop.stat_type}`
    const existing = bestPerStat.get(key)
    if (!existing || entry.streak > existing.streak || (entry.streak === existing.streak && (entry.prop.confidence_score ?? 0) > (existing.prop.confidence_score ?? 0))) {
      bestPerStat.set(key, entry)
    }
  }

  // Sort by streak desc, then confidence desc
  return [...bestPerStat.values()].sort((a, b) => {
    if (b.streak !== a.streak) return b.streak - a.streak
    return (b.prop.confidence_score ?? 0) - (a.prop.confidence_score ?? 0)
  })
}

// ---- Page ----

const STREAK_GROUPS = [10, 9, 8, 7, 6, 5]

export default async function TrendsPage() {
  const entries = await getData()

  // Group by streak length — streaks > 10 are capped into the "10" bucket
  const grouped = new Map<number, StreakEntry[]>()
  for (const entry of entries) {
    const key = Math.min(entry.streak, 10)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(entry)
  }

  const hasAny = entries.length > 0

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-white">Hot Streaks</h1>
        <p className="text-white/40 text-sm">
          Players hitting their line in consecutive recent games
        </p>
      </div>

      {!hasAny && (
        <div className="py-20 text-center text-white/30">
          No hot streaks found. Player game logs may not be populated yet.
        </div>
      )}

      {STREAK_GROUPS.map((n) => {
        const group = grouped.get(n)
        if (!group || group.length === 0) return null

        const label = `${n} for ${n}`

        return (
          <section key={n} className="flex flex-col gap-4">
            {/* Section header */}
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold text-white">{label}</span>
              <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-white/60 text-xs font-semibold">
                {group.length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex flex-col gap-2">
              {group.map(({ prop, streak }, i) => (
                <div
                  key={`${prop.id ?? i}-${streak}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-3 bg-white/[0.04] border border-white/10 rounded-xl px-5 py-4 hover:bg-white/[0.07] transition"
                >
                  {/* Left: player + stat */}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <Link
                      href={`/player/${encodeURIComponent(prop.player_name)}`}
                      className="font-semibold text-white hover:text-blue-400 transition-colors truncate"
                    >
                      {prop.player_name}
                    </Link>
                    <span className="text-xs text-white/40 uppercase tracking-wide">
                      {prop.direction.toUpperCase()} {prop.line} {STAT_LABELS[prop.stat_type]}
                    </span>
                  </div>

                  {/* Center: streak badge */}
                  <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-orange-500/15 border border-orange-500/30">
                    <span className="text-orange-400 text-xs font-bold">{streak} in a row</span>
                  </div>

                  {/* Right: confidence + time */}
                  <div className="flex items-center gap-3 ml-auto">
                    {prop.confidence_label && prop.confidence_score != null && (
                      <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                    )}
                    {prop.commence_time && (
                      <span className="text-white/30 text-xs">{formatGameTime(prop.commence_time)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
