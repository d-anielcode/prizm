// /performance — Live model accuracy tracker
// Computes hit rates from the props table + player_game_logs.
// No dependency on prop_history or prop_results (which have Supabase permission issues).
// Shows accuracy for any props whose game has already completed (game log exists).

import { supabase } from '@/lib/supabase'
import type { StatType } from '@/types'

export const revalidate = 0

// ── Types ─────────────────────────────────────────────────────────────────────
interface GradedProp {
  player_name:      string
  stat_type:        StatType
  line:             number
  direction:        'over' | 'under'
  confidence_label: string | null
  confidence_score: number | null
  actual_value:     number | null
  hit:              boolean | null
  game_date:        string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toEasternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function getActualValue(log: Record<string, unknown>, statType: StatType): number | null {
  switch (statType) {
    case 'points':         return Number(log.points ?? 0)
    case 'rebounds':       return Number(log.rebounds ?? 0)
    case 'assists':        return Number(log.assists ?? 0)
    case 'steals':         return Number(log.steals ?? 0)
    case 'blocks':         return Number(log.blocks ?? 0)
    case 'three_pointers': return Number(log.fg3m ?? 0)
    case 'pra':            return Number(log.pra ?? 0)
    default:               return null
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const target    = new Date(dateStr + 'T00:00:00')
  if (target.getTime() === today.getTime())     return 'Today'
  if (target.getTime() === yesterday.getTime()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadGradedProps(): Promise<GradedProp[]> {
  const now = new Date().toISOString()
  // Only look back 30 days — beyond that props table gets large and old data isn't actionable
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString()

  // 1. Load scored props from the last 30 days
  const { data: rawProps } = await supabase
    .from('props')
    .select('player_name, stat_type, line, direction, confidence_label, confidence_score, commence_time')
    .not('confidence_label', 'is', null)
    .gte('commence_time', cutoff)

  const props = rawProps ?? []
  if (props.length === 0) return []

  // 2. For each prop, figure out the game date
  const propsByDate = new Map<string, typeof props>()
  for (const p of props) {
    if (!p.commence_time) continue
    const gameDate = toEasternDate(p.commence_time as string)
    if (!propsByDate.has(gameDate)) propsByDate.set(gameDate, [])
    propsByDate.get(gameDate)!.push(p)
  }

  if (propsByDate.size === 0) return []

  // 3. Load game logs for all relevant players + dates (paginated)
  const playerNames = [...new Set(props.map((p) => p.player_name as string))]
  const dates       = [...propsByDate.keys()]

  const allLogRows: Record<string, unknown>[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
        .in('player_name', playerNames)
        .in('game_date', dates)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      allLogRows.push(...(page as Record<string, unknown>[]))
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // Index logs by player_name + game_date for fast lookup
  const logIndex = new Map<string, Record<string, unknown>>()
  for (const log of allLogRows) {
    const key = `${log.player_name}|${log.game_date}`
    logIndex.set(key, log as Record<string, unknown>)
  }

  // 4. Grade each prop against its game log
  const graded: GradedProp[] = []

  for (const [gameDate, dateProps] of propsByDate) {
    // Dedup: keep highest-confidence prop per player+stat
    const best = new Map<string, (typeof dateProps)[0]>()
    for (const p of dateProps) {
      const key = `${p.player_name}|${p.stat_type}`
      const ex  = best.get(key)
      if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) best.set(key, p)
    }

    for (const prop of best.values()) {
      const logKey = `${prop.player_name}|${gameDate}`
      const log    = logIndex.get(logKey)

      // Skip DNP (< 5 min) or no log yet (game not played)
      if (!log || Number(log.minutes ?? 0) < 5) {
        // Include as "pending" only if game is in the past
        if (prop.commence_time && new Date(prop.commence_time as string) < new Date(now)) {
          graded.push({
            player_name:      prop.player_name as string,
            stat_type:        prop.stat_type as StatType,
            line:             Number(prop.line),
            direction:        prop.direction as 'over' | 'under',
            confidence_label: prop.confidence_label as string | null,
            confidence_score: prop.confidence_score as number | null,
            actual_value:     null,
            hit:              null,  // pending / DNP
            game_date:        gameDate,
          })
        }
        continue
      }

      const actual = getActualValue(log, prop.stat_type as StatType)
      const hit = actual !== null
        ? (prop.direction === 'over' ? actual > Number(prop.line) : actual < Number(prop.line))
        : null

      graded.push({
        player_name:      prop.player_name as string,
        stat_type:        prop.stat_type as StatType,
        line:             Number(prop.line),
        direction:        prop.direction as 'over' | 'under',
        confidence_label: prop.confidence_label as string | null,
        confidence_score: prop.confidence_score as number | null,
        actual_value:     actual,
        hit,
        game_date:        gameDate,
      })
    }
  }

  return graded
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
const TIER_COLORS = {
  LOCK: { bar: 'bg-violet-500',  text: 'text-violet-400',  badge: 'bg-violet-500/12 border-violet-500/30 text-violet-400',  glow: 'shadow-[0_0_12px_rgba(139,92,246,0.25)]' },
  PLAY: { bar: 'bg-emerald-500', text: 'text-emerald-400', badge: 'bg-emerald-500/12 border-emerald-500/30 text-emerald-400', glow: 'shadow-[0_0_12px_rgba(16,185,129,0.2)]' },
  LEAN: { bar: 'bg-[#e8a820]',  text: 'text-[#f0c060]',   badge: 'bg-[#e8a820]/12 border-[#e8a820]/30 text-[#f0c060]',     glow: 'shadow-[0_0_12px_rgba(232,168,32,0.2)]'  },
  FADE: { bar: 'bg-red-500',    text: 'text-red-400',      badge: 'bg-red-500/12 border-red-500/30 text-red-400',           glow: '' },
}

function HitBar({ rate, colorClass }: { rate: number; colorClass: string }) {
  const pct = Math.round(rate * 100)
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-black w-10 text-right tabular-nums">{pct}%</span>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function PerformancePage() {
  const graded = await loadGradedProps()

  // Only count props that have been graded (hit !== null)
  const resolved = graded.filter((g) => g.hit !== null)
  const pending  = graded.filter((g) => g.hit === null)

  // Rolling totals by confidence tier
  const totals: Record<string, { total: number; hits: number }> = {
    LOCK: { total: 0, hits: 0 },
    PLAY: { total: 0, hits: 0 },
    LEAN: { total: 0, hits: 0 },
    FADE: { total: 0, hits: 0 },
    ALL:  { total: 0, hits: 0 },
  }
  for (const g of resolved) {
    const label = g.confidence_label ?? ''
    if (totals[label]) {
      totals[label].total++
      if (g.hit) totals[label].hits++
    }
    totals.ALL.total++
    if (g.hit) totals.ALL.hits++
  }

  // Group resolved by date for daily breakdown
  const byDate = new Map<string, GradedProp[]>()
  for (const g of resolved) {
    if (!byDate.has(g.game_date)) byDate.set(g.game_date, [])
    byDate.get(g.game_date)!.push(g)
  }
  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a))

  const hasData = resolved.length > 0

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 flex flex-col gap-10">

      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-black text-white tracking-tight">Model Performance</h1>
        <p className="text-white/35 text-sm">
          How many of Prizm&apos;s confidence picks actually hit — tracked daily.
        </p>
      </div>

      {!hasData ? (
        <div className="flex flex-col gap-6">
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-16 flex flex-col items-center gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
              <svg className="w-7 h-7 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div>
              <p className="text-white/50 font-semibold">No graded results yet</p>
              <p className="text-white/25 text-sm mt-1 max-w-sm">
                Results appear automatically once today&apos;s games finish and game logs are fetched.
                {pending.length > 0 && (
                  <span className="block mt-2 text-[#f0c060]/70">
                    {pending.length} prop{pending.length !== 1 ? 's' : ''} pending from today&apos;s games.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* ── Overall rolling stats ── */}
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-white/35 uppercase tracking-widest">
              All-time ({sortedDates.length} day{sortedDates.length !== 1 ? 's' : ''} tracked · {resolved.length} props graded)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(['LOCK', 'PLAY', 'LEAN', 'FADE', 'ALL'] as const).map((label) => {
                const t = totals[label]
                if (!t || t.total === 0) return null
                const pct = Math.round((t.hits / t.total) * 100)
                const c   = label !== 'ALL' ? TIER_COLORS[label] : null
                return (
                  <div
                    key={label}
                    className={`rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-1 ${c?.glow ?? ''}`}
                  >
                    <span className={`text-[10px] font-black uppercase tracking-wider ${c?.text ?? 'text-white/40'}`}>
                      {label === 'ALL' ? 'Overall' : label}
                    </span>
                    <div className="flex items-baseline gap-1.5 mt-1">
                      <span className={`text-3xl font-black ${c?.text ?? 'text-white'}`}>{pct}%</span>
                    </div>
                    <span className="text-xs text-white/25">{t.hits}/{t.total} props hit</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Per-day breakdown ── */}
          <div className="flex flex-col gap-4">
            <p className="text-[11px] text-white/35 uppercase tracking-widest">Daily Breakdown</p>

            {sortedDates.map((date) => {
              const dayGraded = byDate.get(date) ?? []
              const dayTotals: Record<string, { total: number; hits: number }> = {
                LOCK: { total: 0, hits: 0 }, PLAY: { total: 0, hits: 0 }, LEAN: { total: 0, hits: 0 }, FADE: { total: 0, hits: 0 },
              }
              let dayAll = { total: 0, hits: 0 }

              for (const g of dayGraded) {
                const lbl = g.confidence_label ?? ''
                if (dayTotals[lbl]) {
                  dayTotals[lbl].total++
                  if (g.hit) dayTotals[lbl].hits++
                }
                dayAll.total++
                if (g.hit) dayAll.hits++
              }

              const overallPct = dayAll.total > 0
                ? Math.round((dayAll.hits / dayAll.total) * 100)
                : null

              return (
                <div key={date} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/30 to-transparent" />
                  <div className="p-5 flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <p className="font-bold text-white/70">{formatDate(date)}</p>
                      {overallPct !== null && (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-white/30">Overall</span>
                          <span className={`text-sm font-black ${overallPct >= 65 ? 'text-emerald-400' : overallPct >= 55 ? 'text-[#f0c060]' : 'text-red-400'}`}>
                            {overallPct}%
                          </span>
                          <span className="text-xs text-white/25">
                            {dayAll.hits}/{dayAll.total}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col gap-3">
                      {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as const).map((label) => {
                        const row = dayTotals[label]
                        if (!row || row.total === 0) return null
                        const c = TIER_COLORS[label]
                        return (
                          <div key={label} className="flex items-center gap-3">
                            <span className={`text-[10px] font-black w-14 shrink-0 px-1.5 py-0.5 rounded border text-center ${c.badge}`}>
                              {label}
                            </span>
                            <div className="flex-1">
                              <HitBar rate={row.hits / row.total} colorClass={c.bar} />
                            </div>
                            <span className="text-xs text-white/25 shrink-0 w-14 text-right tabular-nums">
                              {row.hits}/{row.total}
                            </span>
                          </div>
                        )
                      })}
                    </div>

                    {/* Individual prop results */}
                    <details className="group">
                      <summary className="text-xs text-white/25 cursor-pointer hover:text-white/45 transition-colors select-none">
                        Show {dayGraded.length} individual props ▸
                      </summary>
                      <div className="mt-3 flex flex-col gap-1.5">
                        {dayGraded
                          .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
                          .map((g, i) => {
                            const c = g.confidence_label ? TIER_COLORS[g.confidence_label as keyof typeof TIER_COLORS] : null
                            return (
                              <div
                                key={i}
                                className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border shrink-0 ${c?.badge ?? 'text-white/30 border-white/10'}`}>
                                    {g.confidence_label ?? '—'}
                                  </span>
                                  <span className="text-xs text-white/60 truncate">{g.player_name}</span>
                                  <span className="text-xs text-white/30 shrink-0">
                                    {g.stat_type === 'three_pointers' ? '3PM' : g.stat_type.toUpperCase().slice(0, 3)}{' '}
                                    {g.direction === 'over' ? '>' : '<'} {g.line}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {g.actual_value !== null && (
                                    <span className="text-xs font-mono text-white/40">
                                      actual: {g.actual_value}
                                    </span>
                                  )}
                                  <span className={`text-xs font-bold ${g.hit === null ? 'text-white/20' : g.hit ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {g.hit === null ? 'PENDING' : g.hit ? '✓ HIT' : '✗ MISS'}
                                  </span>
                                </div>
                              </div>
                            )
                          })}
                      </div>
                    </details>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Pending props callout */}
      {pending.length > 0 && (
        <div className="rounded-xl border border-[#e8a820]/20 bg-[#e8a820]/[0.04] p-4 flex items-start gap-3">
          <div className="w-1.5 h-1.5 rounded-full bg-[#f0c060] mt-1.5 shrink-0 animate-pulse" />
          <div>
            <p className="text-sm text-[#f0c060] font-semibold">
              {pending.length} prop{pending.length !== 1 ? 's' : ''} pending
            </p>
            <p className="text-xs text-white/30 mt-0.5">
              These props are from games still in progress or awaiting box scores.
              Results update automatically after game logs are fetched.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
