import { supabase } from '@/lib/supabase'
import { ConfidenceBadge } from '@/components/ConfidenceBadge'
import Link from 'next/link'
import type { Prop, StatType, Direction, ConfidenceLabel } from '@/types'

// Revalidate every 30 min — streak/accuracy data only changes with daily prop+log refresh
export const revalidate = 1800

// ---- Types ----

interface GameLog {
  player_name: string
  game_date:   string
  points:      number
  rebounds:    number
  assists:     number
  steals:      number
  blocks:      number
  fg3m:        number
  pra:         number
  minutes:     number
}

interface StreakEntry {
  prop:       Prop
  streak:     number
  l10HitRate: number | null
}

interface TierAccuracy {
  label:       ConfidenceLabel
  hitRate:     number
  sampleCount: number
}

// ---- Helpers ----

function getStatValue(log: GameLog, statType: StatType): number {
  switch (statType) {
    case 'points':         return log.points
    case 'rebounds':       return log.rebounds
    case 'assists':        return log.assists
    case 'steals':         return log.steals
    case 'blocks':         return log.blocks
    case 'three_pointers': return log.fg3m
    case 'pra':            return log.pra
    default:               return 0
  }
}

function consecutiveStreak(
  logs: GameLog[],
  statType: StatType,
  line: number,
  direction: Direction,
  wantHit: boolean,  // true = hot streak, false = cold streak
): number {
  let streak = 0
  for (const log of logs) {
    if (log.minutes < 5) continue
    const val = getStatValue(log, statType)
    const hit = direction === 'over' ? val > line : val < line
    if (hit === wantHit) streak++
    else break
  }
  return streak
}

function l10HitRate(
  logs: GameLog[],
  statType: StatType,
  line: number,
  direction: Direction,
): number | null {
  const eligible = logs.filter((g) => g.minutes >= 5).slice(0, 10)
  if (eligible.length < 3) return null
  const hits = eligible.filter((g) => {
    const val = getStatValue(g, statType)
    return direction === 'over' ? val > line : val < line
  }).length
  return hits / eligible.length
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
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: 'America/New_York',
  } as Intl.DateTimeFormatOptions)
}

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

// ---- Data fetching ----

async function loadLogsMap(playerNames: string[]): Promise<Map<string, GameLog[]>> {
  const logsMap = new Map<string, GameLog[]>()
  const PLAYER_BATCH = 50
  for (let i = 0; i < playerNames.length; i += PLAYER_BATCH) {
    const batch = playerNames.slice(i, i + PLAYER_BATCH)
    const { data: logRows, error } = await supabase
      .from('player_game_logs')
      .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
      .in('player_name', batch)
      .order('game_date', { ascending: false })
    if (error) { console.error('[trends] logs error:', error.message); continue }
    for (const row of (logRows ?? [])) {
      const name = String(row.player_name)
      if (!logsMap.has(name)) logsMap.set(name, [])
      logsMap.get(name)!.push({
        player_name: name,
        game_date:   String(row.game_date),
        points:   Number(row.points   ?? 0),
        rebounds: Number(row.rebounds  ?? 0),
        assists:  Number(row.assists   ?? 0),
        steals:   Number(row.steals    ?? 0),
        blocks:   Number(row.blocks    ?? 0),
        fg3m:     Number(row.fg3m      ?? 0),
        pra:      Number(row.pra       ?? 0),
        minutes:  Number(row.minutes   ?? 0),
      })
    }
  }
  return logsMap
}

async function getStreaks(hot: boolean): Promise<StreakEntry[]> {
  const now = new Date().toISOString()
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
  const playerNames = [...new Set(props.map((p) => p.player_name))]
  const logsMap = await loadLogsMap(playerNames)

  const entries: StreakEntry[] = []
  for (const prop of props) {
    const logs = logsMap.get(prop.player_name) ?? []
    if (logs.length === 0) continue
    const streak = consecutiveStreak(logs, prop.stat_type, prop.line, prop.direction, hot)
    if (streak >= 5) {
      entries.push({ prop, streak, l10HitRate: l10HitRate(logs, prop.stat_type, prop.line, prop.direction) })
    }
  }

  // Dedupe: per player+stat keep best streak
  const bestPerStat = new Map<string, StreakEntry>()
  for (const entry of entries) {
    const key = `${entry.prop.player_name}|${entry.prop.stat_type}`
    const existing = bestPerStat.get(key)
    if (!existing || entry.streak > existing.streak ||
        (entry.streak === existing.streak && (entry.prop.confidence_score ?? 0) > (existing.prop.confidence_score ?? 0))) {
      bestPerStat.set(key, entry)
    }
  }

  return [...bestPerStat.values()].sort((a, b) => {
    if (b.streak !== a.streak) return b.streak - a.streak
    return (b.prop.confidence_score ?? 0) - (a.prop.confidence_score ?? 0)
  })
}

async function getTierAccuracy(): Promise<TierAccuracy[]> {
  // Read from prop_grades — pre-graded hit/miss records populated by /api/grade
  const cutoff = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10)
  const gradeRows: Record<string, unknown>[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('prop_grades')
      .select('confidence_label, hit')
      .not('confidence_label', 'is', null)
      .not('hit', 'is', null)
      .gte('game_date', cutoff)
      .range(from, from + PAGE - 1)
    if (error) { console.error('[trends] prop_grades error:', error.message); break }
    if (!data || data.length === 0) break
    gradeRows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  if (gradeRows.length === 0) return []

  const tally: Record<string, { hits: number; total: number }> = {
    LOCK: { hits: 0, total: 0 },
    PLAY: { hits: 0, total: 0 },
    LEAN: { hits: 0, total: 0 },
    FADE: { hits: 0, total: 0 },
  }

  for (const row of gradeRows) {
    const label = row.confidence_label as string
    if (!(label in tally)) continue
    tally[label].total++
    if (row.hit === true) tally[label].hits++
  }

  const ORDER: ConfidenceLabel[] = ['LOCK', 'PLAY', 'LEAN', 'FADE']
  return ORDER
    .filter((label) => tally[label].total >= 5)
    .map((label) => ({
      label,
      hitRate:     tally[label].hits / tally[label].total,
      sampleCount: tally[label].total,
    }))
}

// ---- UI helpers ----

function hitRateColor(rate: number): string {
  if (rate >= 0.65) return 'text-emerald-400'
  if (rate >= 0.52) return 'text-[#FFB800]'
  return 'text-red-400'
}

function tierTargetRate(label: ConfidenceLabel): number {
  // Expected hit rates per tier (from model calibration targets)
  return label === 'LOCK' ? 0.78 : label === 'PLAY' ? 0.70 : label === 'LEAN' ? 0.55 : 0.38
}

const TIER_COLORS: Record<ConfidenceLabel, string> = {
  LOCK: 'text-violet-400',
  PLAY: 'text-emerald-400',
  LEAN: 'text-[#3B82F6]',
  FADE: 'text-red-400',
}

// ---- Page ----

const STREAK_GROUPS = [10, 9, 8, 7, 6, 5]

export default async function TrendsPage() {
  const [hotEntries, coldEntries, tierAccuracy] = await Promise.all([
    getStreaks(true),
    getStreaks(false),
    getTierAccuracy(),
  ])

  const grouped = (entries: StreakEntry[]) => {
    const map = new Map<number, StreakEntry[]>()
    for (const entry of entries) {
      const key = Math.min(entry.streak, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(entry)
    }
    return map
  }

  const hotGrouped  = grouped(hotEntries)
  const coldGrouped = grouped(coldEntries)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-10">

      {/* ── Tier Accuracy ── */}
      {tierAccuracy.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-bold text-white">Model Accuracy <span className="text-white/30 font-normal text-sm">(last 45 days)</span></h2>
            <p className="text-white/40 text-xs">Actual hit rate vs target for each confidence tier</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {tierAccuracy.map(({ label, hitRate, sampleCount }) => {
              const target  = tierTargetRate(label)
              const delta   = hitRate - target
              const onTrack = Math.abs(delta) <= 0.05
              const above   = delta > 0.05
              return (
                <div key={label} className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-black tracking-wide ${TIER_COLORS[label]}`}>{label}</span>
                    <span className="text-[10px] text-white/25">{sampleCount} props</span>
                  </div>
                  <span className={`text-2xl font-black ${hitRateColor(label === 'FADE' ? 1 - hitRate : hitRate)}`}>
                    {Math.round(hitRate * 100)}%
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-white/30">target {Math.round(target * 100)}%</span>
                    <span className={`text-[10px] font-bold ${onTrack ? 'text-white/30' : above ? 'text-emerald-400' : 'text-red-400'}`}>
                      {onTrack ? '✓' : above ? `+${Math.round(delta * 100)}pp` : `${Math.round(delta * 100)}pp`}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Hot Streaks ── */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-orange-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            <h1 className="text-2xl font-bold text-white">Hot Streaks</h1>
          </div>
          <p className="text-white/40 text-sm">Players hitting their line in consecutive recent games</p>
        </div>

        {hotEntries.length === 0 ? (
          <div className="py-12 text-center text-white/30">No hot streaks found.</div>
        ) : STREAK_GROUPS.map((n) => {
          const group = hotGrouped.get(n)
          if (!group || group.length === 0) return null
          return (
            <div key={n} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="text-xl font-bold text-white">{n} for {n}</span>
                <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-white/60 text-xs font-semibold">{group.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {group.map(({ prop, streak, l10HitRate: l10 }, i) => (
                  <StreakCard key={`hot-${prop.id ?? i}-${streak}`} prop={prop} streak={streak} l10={l10} hot />
                ))}
              </div>
            </div>
          )
        })}
      </section>

      {/* ── Cold Streaks ── */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 17h8m0 0v-8m0 8l-8-8-4 4-6-6" />
            </svg>
            <h2 className="text-2xl font-bold text-white">Cold Streaks</h2>
          </div>
          <p className="text-white/40 text-sm">Players consistently missing their line — potential fade targets</p>
        </div>

        {coldEntries.length === 0 ? (
          <div className="py-12 text-center text-white/30">No cold streaks found.</div>
        ) : STREAK_GROUPS.map((n) => {
          const group = coldGrouped.get(n)
          if (!group || group.length === 0) return null
          return (
            <div key={n} className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="text-xl font-bold text-white">{n} for {n}</span>
                <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-white/60 text-xs font-semibold">{group.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {group.map(({ prop, streak, l10HitRate: l10 }, i) => (
                  <StreakCard key={`cold-${prop.id ?? i}-${streak}`} prop={prop} streak={streak} l10={l10} hot={false} />
                ))}
              </div>
            </div>
          )
        })}
      </section>

    </div>
  )
}

function StreakCard({ prop, streak, l10, hot }: { prop: Prop; streak: number; l10: number | null; hot: boolean }) {
  const badgeBg   = hot ? 'bg-orange-500/15 border-orange-500/30' : 'bg-blue-500/15 border-blue-500/30'
  const badgeText = hot ? 'text-orange-400' : 'text-blue-400'

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-white/[0.04] border border-white/10 rounded-xl px-5 py-4 hover:bg-white/[0.07] transition">
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

      {/* Center: streak + L10 */}
      <div className="flex items-center gap-2">
        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border ${badgeBg}`}>
          <span className={`text-xs font-bold ${badgeText}`}>{streak} in a row</span>
        </div>
        {l10 != null && (
          <span className={`text-xs font-semibold ${hitRateColor(hot ? l10 : 1 - l10)}`}>
            L10: {Math.round(l10 * 100)}%
          </span>
        )}
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
  )
}
