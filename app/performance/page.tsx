// /performance — Live model accuracy tracker
// Reads aggregate hit/miss counts from prop_grades.
// Two lean parallel queries: all-time totals + last 5 game days.

import { supabase } from '@/lib/supabase'

export const revalidate = 0

// ── Types ─────────────────────────────────────────────────────────────────────
type Tally = { total: number; hits: number }
type TierMap = Record<string, Tally>

interface GradedLeg {
  player_name: string
  team:        string
  stat_type:   string
  line:        number
  direction:   'over' | 'under'
  actual:      number | null
  hit:         boolean | null
  l10_hits:    number
  l10_total:   number
}

interface GradedParlay {
  id:             string
  title:          string
  game_date:      string
  parlay_type:    string
  est_multiplier: number
  legs:           GradedLeg[]
  hit:            boolean | null
  leg_hit_rate:   number | null
  is_pending:     boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const target    = new Date(dateStr + 'T00:00:00')
  if (target.getTime() === today.getTime())     return 'Today'
  if (target.getTime() === yesterday.getTime()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function blankTierMap(): TierMap {
  return {
    LOCK: { total: 0, hits: 0 },
    PLAY: { total: 0, hits: 0 },
    LEAN: { total: 0, hits: 0 },
    FADE: { total: 0, hits: 0 },
    ALL:  { total: 0, hits: 0 },
  }
}

function tally(map: TierMap, label: string, hit: boolean) {
  if (map[label]) { map[label].total++; if (hit) map[label].hits++ }
  map.ALL.total++; if (hit) map.ALL.hits++
}

// ── Data loading ──────────────────────────────────────────────────────────────

// All-time totals: lean query — only confidence_label + hit, no date cutoff
async function loadAllTimeTotals(): Promise<{ totals: TierMap; days: number }> {
  const { data } = await supabase
    .from('prop_grades')
    .select('game_date, confidence_label, hit')
    .not('confidence_label', 'is', null)
    .not('hit', 'is', null)
    .limit(100000)

  const totals = blankTierMap()
  const dates  = new Set<string>()
  for (const row of data ?? []) {
    tally(totals, row.confidence_label as string, row.hit as boolean)
    dates.add(row.game_date as string)
  }
  return { totals, days: dates.size }
}

// Daily breakdown: last 5 game days, lean 3-column query
async function loadDailyBreakdown(): Promise<Map<string, TierMap>> {
  const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const cutoff = new Date(Date.now() - 10 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })  // 10 calendar days to get 5 game days

  const { data } = await supabase
    .from('prop_grades')
    .select('game_date, confidence_label, hit')
    .not('confidence_label', 'is', null)
    .not('hit', 'is', null)
    .gte('game_date', cutoff)
    .lte('game_date', today)
    .order('game_date', { ascending: false })
    .limit(5000)

  const byDate = new Map<string, TierMap>()
  for (const row of data ?? []) {
    const date = row.game_date as string
    if (!byDate.has(date)) byDate.set(date, blankTierMap())
    tally(byDate.get(date)!, row.confidence_label as string, row.hit as boolean)
  }

  // Cap at 5 most recent game days
  const top5 = [...byDate.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 5)
  return new Map(top5.map((d) => [d, byDate.get(d)!]))
}

async function loadGradedParlays(): Promise<GradedParlay[]> {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]

  const { data: parlays } = await supabase
    .from('curated_parlays')
    .select('id, title, game_date, parlay_type, est_multiplier, legs, result')
    .eq('active', true)
    .gte('game_date', cutoff)
    .order('game_date', { ascending: false })

  if (!parlays || parlays.length === 0) return []

  const lookups = new Set<string>()
  for (const p of parlays) {
    for (const l of (p.legs as GradedLeg[] | null) ?? [])
      lookups.add(`${l.player_name}|${p.game_date}`)
  }

  const playerNames = [...new Set([...lookups].map((k) => k.split('|')[0]))]
  const gameDates   = [...new Set([...lookups].map((k) => k.split('|')[1]))]

  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
    .in('player_name', playerNames)
    .in('game_date', gameDates)

  const logIndex = new Map<string, Record<string, unknown>>()
  for (const log of logsRaw ?? [])
    logIndex.set(`${log.player_name}|${log.game_date}`, log as Record<string, unknown>)

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  function getActual(log: Record<string, unknown>, stat: string): number | null {
    const map: Record<string, string> = { points: 'points', rebounds: 'rebounds', assists: 'assists', steals: 'steals', blocks: 'blocks', three_pointers: 'fg3m', pra: 'pra' }
    const f = map[stat]; return f != null && log[f] != null ? Number(log[f]) : null
  }

  return parlays.map((p) => {
    const legs      = (p.legs as Array<Record<string, unknown>> | null) ?? []
    const isPending = (p.game_date as string) >= today

    const gradedLegs: GradedLeg[] = legs.map((l) => {
      const log    = logIndex.get(`${l.player_name}|${p.game_date}`)
      const mins   = log ? Number(log.minutes ?? 0) : null
      const noData = !log || (mins !== null && mins < 5)
      const actual = noData ? null : getActual(log!, l.stat_type as string)
      const hit    = actual === null ? null
        : l.direction === 'over' ? actual > Number(l.line) : actual < Number(l.line)
      return {
        player_name: l.player_name as string,
        team:        l.team as string,
        stat_type:   l.stat_type as string,
        line:        Number(l.line),
        direction:   l.direction as 'over' | 'under',
        actual, hit,
        l10_hits:  Number(l.l10_hits ?? 0),
        l10_total: Number(l.l10_total ?? 1),
      }
    })

    const settledLegs = gradedLegs.filter((l) => l.hit !== null)
    const hitLegs     = settledLegs.filter((l) => l.hit === true)
    const storedResult = p.result as string | null
    const parlayHit = isPending ? null
      : storedResult === 'hit'  ? true
      : storedResult === 'miss' ? false
      : storedResult === 'void' ? null
      : gradedLegs.some((l) => l.hit === false) ? false
      : gradedLegs.every((l) => l.hit === true) ? true
      : null

    return {
      id:             p.id as string,
      title:          p.title as string,
      game_date:      p.game_date as string,
      parlay_type:    (p.parlay_type as string) ?? 'sgp',
      est_multiplier: Number(p.est_multiplier),
      legs:           gradedLegs,
      hit:            parlayHit,
      leg_hit_rate:   settledLegs.length > 0 ? hitLegs.length / settledLegs.length : null,
      is_pending:     isPending,
    }
  })
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
  const [{ totals, days }, dailyBreakdown, gradedParlays] = await Promise.all([
    loadAllTimeTotals(),
    loadDailyBreakdown(),
    loadGradedParlays(),
  ])

  const hasData = totals.ALL.total > 0

  const valueParlays   = gradedParlays.filter((p) => p.parlay_type === 'value')
  const premiumParlays = gradedParlays.filter((p) => p.parlay_type === 'premium')
  const jackpotParlays = gradedParlays.filter((p) => p.parlay_type === 'jackpot')

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
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* ── All-time rolling stats ── */}
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-white/35 uppercase tracking-widest">
              All-time ({days} day{days !== 1 ? 's' : ''} tracked · {totals.ALL.total} props graded)
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

          {/* ── Per-day breakdown (last 5 game days) ── */}
          <div className="flex flex-col gap-4">
            <p className="text-[11px] text-white/35 uppercase tracking-widest">Daily Breakdown</p>

            {[...dailyBreakdown.entries()].map(([date, dayTotals]) => {
              const dayAll = dayTotals.ALL
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
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── Curated Parlays ── */}
      {([
        { label: 'Consistent Picks', sublabel: '3-leg · PTS/REB/AST/3PM · LOCK+PLAY · ~33% hit rate',  parlays: valueParlays,   accent: 'text-emerald-400', dot: 'bg-emerald-400', minHitPct: 28 },
        { label: 'High Rollers',     sublabel: '4-leg · PTS/REB/AST/3PM · 24+ min avg · ~10x payout',  parlays: premiumParlays, accent: 'text-[#e8a820]',   dot: 'bg-[#e8a820]',   minHitPct: 12 },
        { label: 'Jackpot',          sublabel: '5-leg · PTS/REB/AST/3PM · 24+ min avg · ~17x payout',  parlays: jackpotParlays, accent: 'text-violet-400', dot: 'bg-violet-400', minHitPct: 8  },
      ] as const).map(({ label, sublabel, parlays, accent, dot, minHitPct }) => {
        const settled   = parlays.filter((p) => p.hit !== null)
        const hits      = settled.filter((p) => p.hit === true)
        const allLegs   = parlays.flatMap((p) => p.legs).filter((l) => l.hit !== null)
        const legHits   = allLegs.filter((l) => l.hit === true)
        const parlayPct = settled.length > 0 ? Math.round(hits.length / settled.length * 100) : null
        const legPct    = allLegs.length  > 0 ? Math.round(legHits.length / allLegs.length * 100) : null
        const STAT_SHORT: Record<string, string> = { points: 'PTS', rebounds: 'REB', assists: 'AST', steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA' }

        return (
          <div key={label} className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <p className="text-[11px] text-white/35 uppercase tracking-widest">{label}</p>
                <p className="text-[10px] text-white/20">{sublabel}</p>
              </div>
              <span className="text-[10px] text-white/20">{parlays.length} parlay{parlays.length !== 1 ? 's' : ''} · last 30 days</span>
            </div>

            {parlays.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.01] p-8 text-center">
                <p className="text-sm text-white/25">No {label.toLowerCase()} tracked yet</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { stat: 'Parlay Hit Rate', value: parlayPct !== null ? `${parlayPct}%` : '—', sub: `${hits.length}/${settled.length} settled`, color: parlayPct !== null && parlayPct >= minHitPct ? accent : 'text-white' },
                    { stat: 'Leg Hit Rate',    value: legPct    !== null ? `${legPct}%`    : '—', sub: `${legHits.length}/${allLegs.length} legs`,   color: legPct    !== null && legPct    >= 60       ? accent : 'text-white' },
                    { stat: 'Pending',         value: String(parlays.filter((p) => p.is_pending).length), sub: 'awaiting results', color: 'text-[#f0c060]' },
                  ].map(({ stat, value, sub, color }) => (
                    <div key={stat} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-1">
                      <span className="text-[10px] font-black uppercase tracking-wider text-white/30">{stat}</span>
                      <span className={`text-2xl font-black mt-1 ${color}`}>{value}</span>
                      <span className="text-xs text-white/25">{sub}</span>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-2">
                  {parlays.map((parlay) => {
                    const statusColor = parlay.is_pending ? 'text-[#f0c060]'
                      : parlay.hit === null ? 'text-white/25'
                      : parlay.hit ? 'text-emerald-400' : 'text-red-400'
                    const statusText  = parlay.is_pending ? 'PENDING'
                      : parlay.hit === null ? 'VOID'
                      : parlay.hit ? `HIT ~${parlay.est_multiplier}×` : 'MISS'
                    const settledLegs = parlay.legs.filter((l) => l.hit !== null)
                    const hitCount    = settledLegs.filter((l) => l.hit).length

                    return (
                      <details key={parlay.id} className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                        <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none hover:bg-white/[0.02] transition-colors list-none">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`w-2 h-2 rounded-full shrink-0 ${
                              parlay.is_pending ? `${dot} animate-pulse`
                              : parlay.hit === null ? 'bg-white/20'
                              : parlay.hit ? 'bg-emerald-400' : 'bg-red-400'
                            }`} />
                            <span className="text-sm font-semibold text-white/70 truncate">{parlay.title}</span>
                            <span className="text-xs text-white/25 shrink-0">{parlay.game_date}</span>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {!parlay.is_pending && settledLegs.length > 0 && (
                              <span className="text-xs text-white/30">{hitCount}/{settledLegs.length} legs</span>
                            )}
                            <span className={`text-xs font-black ${statusColor}`}>{statusText}</span>
                          </div>
                        </summary>

                        <div className="border-t border-white/[0.05] px-4 py-3 flex flex-col gap-1.5">
                          {parlay.legs.map((leg, i) => (
                            <div key={i} className="flex items-center justify-between gap-2 py-1">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-xs text-white/50 truncate">{leg.player_name}</span>
                                <span className="text-xs text-white/25 shrink-0">
                                  {leg.direction === 'over' ? 'O' : 'U'}{leg.line} {STAT_SHORT[leg.stat_type] ?? leg.stat_type}
                                </span>
                                <span className="text-[10px] text-white/20 shrink-0">{leg.l10_hits}/{leg.l10_total} L{leg.l10_total}</span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {leg.actual !== null && (
                                  <span className="text-xs font-mono text-white/30">actual: {leg.actual}</span>
                                )}
                                <span className={`text-xs font-bold ${leg.hit === null ? 'text-white/20' : leg.hit ? 'text-emerald-400' : 'text-red-400'}`}>
                                  {leg.hit === null ? (parlay.is_pending ? '—' : 'VOID') : leg.hit ? '✓' : '✗'}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
