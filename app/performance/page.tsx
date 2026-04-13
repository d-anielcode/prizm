// /performance — Live model accuracy tracker
// Reads aggregate hit/miss counts from prop_grades.
// Two lean parallel queries: all-time totals + last 5 game days.

import { supabase } from '@/lib/supabase'

// Revalidate every 30 min — performance data only changes after nightly grading
export const revalidate = 1800

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
  pass?:          number | null
  change_summary?: string | null
  original_legs?: GradedLeg[] | null  // morning pick legs (if this is a Pass 2 update)
  original_hit?:  boolean | null      // what the morning pick would have scored
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

// All-time totals: paginated lean query — only 3 columns, no date cutoff
async function loadAllTimeTotals(): Promise<{ totals: TierMap; days: number }> {
  const totals = blankTierMap()
  const dates  = new Set<string>()
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: page } = await supabase
      .from('prop_grades')
      .select('game_date, confidence_label, hit')
      .not('confidence_label', 'is', null)
      .not('hit', 'is', null)
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    for (const row of page) {
      tally(totals, row.confidence_label as string, row.hit as boolean)
      dates.add(row.game_date as string)
    }
    if (page.length < PAGE) break
    from += PAGE
  }
  return { totals, days: dates.size }
}

// Daily breakdown: reads from prop_results (same source as Model Performance on home page).
// This ensures the daily breakdown always matches the authoritative aggregated results table,
// avoiding stale snapshot data or the 5000-row limit issue from querying prop_grades directly.
const RESULT_TIERS = new Set(['LOCK', 'PLAY', 'LEAN', 'FADE'])

async function loadDailyBreakdownFromResults(): Promise<Map<string, TierMap>> {
  const cutoff = new Date(Date.now() - 7 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // 7 calendar days back

  const { data } = await supabase
    .from('prop_results')
    .select('date, confidence_label, total, hits')
    .gte('date', cutoff)
    .order('date', { ascending: false })
    .limit(28) // 4 tiers × 7 days

  const byDate = new Map<string, TierMap>()
  for (const row of (data ?? []) as { date: string; confidence_label: string; total: number; hits: number }[]) {
    // Skip aggregate rows (e.g. confidence_label = 'ALL') — we compute ALL ourselves
    if (!RESULT_TIERS.has(row.confidence_label)) continue
    if (!byDate.has(row.date)) byDate.set(row.date, blankTierMap())
    const tm = byDate.get(row.date)!
    tm[row.confidence_label].total = row.total
    tm[row.confidence_label].hits  = row.hits
    tm.ALL.total += row.total
    tm.ALL.hits  += row.hits
  }

  return new Map([...byDate.keys()].sort((a, b) => b.localeCompare(a)).map((d) => [d, byDate.get(d)!]))
}

// ── Calibration data ──────────────────────────────────────────────────────────
// Pulls confidence_score + direction + stat_type + hit from all graded props.
// Used for: score-bucket calibration, OVER/UNDER split, stat-type accuracy.

interface CalibBucket { label: string; min: number; max: number; hits: number; total: number }
interface DirSplit    { hits: number; total: number }

interface CalibrationData {
  buckets:           CalibBucket[]
  byDirection:       { over: DirSplit; under: DirSplit }
  byLabelDir:        Record<string, { over: DirSplit; under: DirSplit }>
  byStatType:        Record<string, { hits: number; total: number }>
  // Recommended OVER correction relative to current -3:
  // derived as -round((under_rate - over_rate) * 100 / 2.33)
  // where 2.33 ≈ score-pts per 1% probability shift (empirical)
  recommendedOverAdj: number
  currentOverAdj:     number
  sampleSize:         number
}

const CALIB_BUCKETS = [
  { label: '50–54', min: 50, max: 54 },
  { label: '55–59', min: 55, max: 59 },
  { label: '60–64', min: 60, max: 64 },
  { label: '65–69', min: 65, max: 69 },
  { label: '70–74', min: 70, max: 74 },
  { label: '75–79', min: 75, max: 79 },
  { label: '80–84', min: 80, max: 84 },
  { label: '85+',   min: 85, max: 99 },
]

async function loadCalibrationData(): Promise<CalibrationData> {
  const rows: { confidence_score: number; confidence_label: string; direction: string; stat_type: string; hit: boolean }[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: page } = await supabase
      .from('prop_grades')
      .select('confidence_score, confidence_label, direction, stat_type, hit')
      .not('confidence_score', 'is', null)
      .not('hit', 'is', null)
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    rows.push(...(page as typeof rows))
    if (page.length < PAGE) break
    from += PAGE
  }

  // Score buckets
  const buckets: CalibBucket[] = CALIB_BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => r.confidence_score >= b.min && r.confidence_score <= b.max)
    return { ...b, hits: inBucket.filter((r) => r.hit).length, total: inBucket.length }
  })

  // OVER vs UNDER split overall
  const byDirection = {
    over:  { hits: rows.filter((r) => r.direction === 'over'  && r.hit).length, total: rows.filter((r) => r.direction === 'over').length },
    under: { hits: rows.filter((r) => r.direction === 'under' && r.hit).length, total: rows.filter((r) => r.direction === 'under').length },
  }

  // By label + direction
  const byLabelDir: CalibrationData['byLabelDir'] = {}
  for (const label of ['LOCK', 'PLAY', 'LEAN', 'FADE']) {
    const sub = rows.filter((r) => r.confidence_label === label)
    byLabelDir[label] = {
      over:  { hits: sub.filter((r) => r.direction === 'over'  && r.hit).length, total: sub.filter((r) => r.direction === 'over').length },
      under: { hits: sub.filter((r) => r.direction === 'under' && r.hit).length, total: sub.filter((r) => r.direction === 'under').length },
    }
  }

  // By stat type (all labels)
  const byStatType: Record<string, { hits: number; total: number }> = {}
  for (const r of rows) {
    if (!byStatType[r.stat_type]) byStatType[r.stat_type] = { hits: 0, total: 0 }
    byStatType[r.stat_type].total++
    if (r.hit) byStatType[r.stat_type].hits++
  }

  // Recommended OVER correction
  const overRate  = byDirection.over.total  > 0 ? byDirection.over.hits  / byDirection.over.total  : null
  const underRate = byDirection.under.total > 0 ? byDirection.under.hits / byDirection.under.total : null
  const gap = (overRate != null && underRate != null) ? underRate - overRate : 0
  // Each model score point ≈ 1% probability shift. Gap in % → score point correction.
  const recommendedOverAdj = gap > 0 ? -Math.round(gap * 100) : 0

  return { buckets, byDirection, byLabelDir, byStatType, recommendedOverAdj, currentOverAdj: -3, sampleSize: rows.length }
}

// ── Streak data ───────────────────────────────────────────────────────────────
interface StreakEntry {
  id:        string
  game_date: string
  legs:      GradedLeg[]
  result:    'hit' | 'miss' | 'void' | null
  isPending: boolean
}

interface StreakData {
  currentStreak:      number
  longestStreak:      number
  totalDays:          number
  hitRate:            number | null
  currentStreakPicks: StreakEntry[]
  allHistory:         StreakEntry[]
}

async function loadStreakData(): Promise<StreakData> {
  const { data: raw } = await supabase
    .from('curated_parlays')
    .select('id, game_date, legs, result, pass, change_summary')
    .eq('active', true)
    .or('superseded.is.null,superseded.eq.false')
    .eq('parlay_type', 'streak')
    .order('game_date', { ascending: false })
    .limit(60)

  if (!raw || raw.length === 0) {
    return { currentStreak: 0, longestStreak: 0, totalDays: 0, hitRate: null, currentStreakPicks: [], allHistory: [] }
  }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // Fetch game logs for actual results
  const playerNames = [...new Set(raw.flatMap((p) => ((p.legs as GradedLeg[]) ?? []).map((l) => l.player_name)))]
  const gameDates   = [...new Set(raw.map((p) => p.game_date as string))]

  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
    .in('player_name', playerNames)
    .in('game_date', gameDates)

  const logIndex = new Map<string, Record<string, unknown>>()
  for (const log of logsRaw ?? [])
    logIndex.set(`${log.player_name}|${log.game_date}`, log as Record<string, unknown>)

  function getActual(log: Record<string, unknown>, stat: string): number | null {
    const map: Record<string, string> = { points: 'points', rebounds: 'rebounds', assists: 'assists', steals: 'steals', blocks: 'blocks', three_pointers: 'fg3m', pra: 'pra' }
    const f = map[stat]; return f != null && log[f] != null ? Number(log[f]) : null
  }

  const entries: StreakEntry[] = raw.map((p) => {
    const isPending = (p.game_date as string) >= today
    const legs = ((p.legs as Array<Record<string, unknown>>) ?? []).map((l) => {
      const log    = logIndex.get(`${l.player_name}|${p.game_date}`)
      const mins   = log ? Number(log.minutes ?? 0) : null
      const noData = !log || (mins !== null && mins < 5)
      const actual = (noData || isPending) ? null : getActual(log!, l.stat_type as string)
      const hit    = actual === null ? null
        : l.direction === 'over' ? actual > Number(l.line) : actual < Number(l.line)
      return {
        player_name: l.player_name as string,
        team:        (l.team ?? '') as string,
        stat_type:   l.stat_type as string,
        line:        Number(l.line),
        direction:   l.direction as 'over' | 'under',
        actual, hit,
        l10_hits:  Number(l.l10_hits ?? 0),
        l10_total: Number(l.l10_total ?? 1),
      }
    })
    return {
      id:        p.id as string,
      game_date: p.game_date as string,
      legs,
      result:    p.result as 'hit' | 'miss' | 'void' | null,
      isPending,
    }
  })

  // Current streak: consecutive hits from most recent graded day
  let currentStreak = 0
  const currentStreakPicks: StreakEntry[] = []
  for (const e of entries) {
    if (e.isPending) { currentStreakPicks.unshift(e); continue }
    if (e.result === 'hit') { currentStreak++; currentStreakPicks.unshift(e) }
    else break
  }

  // Longest streak ever
  let longestStreak = 0
  let run = 0
  for (const e of [...entries].reverse()) {
    if (e.result === 'hit') { run++; longestStreak = Math.max(longestStreak, run) }
    else if (e.result === 'miss') run = 0
  }

  // Hit rate
  const graded = entries.filter((e) => e.result === 'hit' || e.result === 'miss')
  const hits   = graded.filter((e) => e.result === 'hit')
  const hitRate = graded.length > 0 ? hits.length / graded.length : null

  return {
    currentStreak,
    longestStreak,
    totalDays: entries.length,
    hitRate,
    currentStreakPicks,
    allHistory: entries,
  }
}

async function loadGradedParlays(): Promise<GradedParlay[]> {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]

  const { data: parlays } = await supabase
    .from('curated_parlays')
    .select('id, title, game_date, parlay_type, est_multiplier, legs, result, pass, change_summary, replaces_id')
    .eq('active', true)
    .or('superseded.is.null,superseded.eq.false')
    .gte('game_date', cutoff)
    .order('game_date', { ascending: false })

  if (!parlays || parlays.length === 0) return []

  // Also load superseded (original morning) parlays for Pass 2 comparison display
  const replacesIds = parlays
    .filter((p) => (p as Record<string, unknown>).replaces_id)
    .map((p) => (p as Record<string, unknown>).replaces_id as string)

  const originalMap = new Map<string, Record<string, unknown>>()
  if (replacesIds.length > 0) {
    const { data: originals } = await supabase
      .from('curated_parlays')
      .select('id, legs')
      .in('id', replacesIds)
    for (const o of originals ?? []) {
      originalMap.set(o.id as string, o as Record<string, unknown>)
    }
  }

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

    const playableLegs = gradedLegs.filter((l) => l.hit !== null)
    const settledLegs  = playableLegs
    const hitLegs      = settledLegs.filter((l) => l.hit === true)
    const storedResult = p.result as string | null

    // Sportsbook rules: void legs are removed, remaining legs evaluated normally.
    // Only fully void if no playable legs remain.
    let parlayHit: boolean | null
    if (isPending) {
      parlayHit = null
    } else if (storedResult === 'hit') {
      parlayHit = true
    } else if (storedResult === 'miss') {
      parlayHit = false
    } else if (storedResult === 'void' && playableLegs.length > 0) {
      // Re-evaluate voided parlays: if playable legs exist, use sportsbook rules
      parlayHit = playableLegs.some((l) => l.hit === false) ? false
        : playableLegs.every((l) => l.hit === true) ? true
        : null
    } else if (storedResult === 'void') {
      parlayHit = null // truly void — no playable legs
    } else {
      // No stored result — compute from legs (sportsbook void rules)
      parlayHit = playableLegs.length === 0 ? null
        : playableLegs.some((l) => l.hit === false) ? false
        : playableLegs.every((l) => l.hit === true) ? true
        : null
    }

    // If this is a Pass 2 update, grade the original morning legs too
    const replacesId = (p as Record<string, unknown>).replaces_id as string | null
    let originalLegs: GradedLeg[] | null = null
    let originalHit: boolean | null = null

    if (replacesId && originalMap.has(replacesId)) {
      const origParlay = originalMap.get(replacesId)!
      const origRawLegs = (origParlay.legs as Array<Record<string, unknown>> | null) ?? []
      originalLegs = origRawLegs.map((l) => {
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
      const origPlayable = originalLegs.filter((l) => l.hit !== null)
      originalHit = origPlayable.length === 0 ? null
        : origPlayable.some((l) => l.hit === false) ? false
        : origPlayable.every((l) => l.hit === true) ? true
        : null
    }

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
      pass:           (p as Record<string, unknown>).pass as number | null,
      change_summary: (p as Record<string, unknown>).change_summary as string | null,
      original_legs:  originalLegs,
      original_hit:   originalHit,
    }
  })
}

// ── UI helpers ─────────────────────────────────────────────────────────────────
const TIER_COLORS = {
  LOCK: { bar: 'bg-[#00D68F]',  text: 'text-[#00D68F]',  badge: 'bg-[#00D68F]/12 border-[#00D68F]/30 text-[#00D68F]',  glow: 'shadow-[0_0_12px_rgba(0,214,143,0.25)]' },
  PLAY: { bar: 'bg-[#FFB800]', text: 'text-[#FFB800]', badge: 'bg-[#FFB800]/12 border-[#FFB800]/30 text-[#FFB800]', glow: 'shadow-[0_0_12px_rgba(255,184,0,0.2)]' },
  LEAN: { bar: 'bg-[#3B82F6]', text: 'text-[#3B82F6]',  badge: 'bg-[#3B82F6]/12 border-[#3B82F6]/30 text-[#3B82F6]',     glow: 'shadow-[0_0_12px_rgba(59,130,246,0.2)]'  },
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

// ── Snapshot reader ───────────────────────────────────────────────────────────
// Reads the pre-computed Props History snapshot (populated by /api/performance-snapshot
// after each grading run). Falls back to live queries if the snapshot is missing or stale.

interface SnapshotRow {
  computed_at:     string
  totals:          TierMap
  days:            number
  daily_breakdown: Array<{ date: string; tiers: TierMap }>
  calibration:     CalibrationData
}

async function loadPropsDataFromSnapshot(): Promise<{
  totals: TierMap; days: number; dailyBreakdown: Map<string, TierMap>; calibration: CalibrationData
} | null> {
  const { data, error } = await supabase
    .from('performance_snapshot')
    .select('computed_at, totals, days, daily_breakdown, calibration')
    .eq('id', 1)
    .single()

  if (error || !data) return null

  const row = data as unknown as SnapshotRow
  // Accept snapshot if computed within the last 6 hours
  const ageMs = Date.now() - new Date(row.computed_at).getTime()
  if (ageMs > 6 * 3600 * 1000) return null

  const dailyBreakdown = new Map<string, TierMap>()
  for (const { date, tiers } of row.daily_breakdown ?? [])
    dailyBreakdown.set(date, tiers)

  return { totals: row.totals, days: row.days, dailyBreakdown, calibration: row.calibration }
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await searchParams
  const tab = rawTab === 'parlays' ? 'parlays' : rawTab === 'streaks' ? 'streaks' : 'props'

  // Only load data needed for the active tab
  const [
    propsData,
    gradedParlays,
    streakData,
    dailyBreakdownLive,
  ] = await Promise.all([
    tab === 'props'
      ? (async () => {
          // Try snapshot first (single fast SELECT). Fall back to live paginated queries.
          const snap = await loadPropsDataFromSnapshot()
          if (snap) return snap
          const [a, c] = await Promise.all([loadAllTimeTotals(), loadCalibrationData()])
          return { totals: a.totals, days: a.days, dailyBreakdown: new Map<string, TierMap>(), calibration: c }
        })()
      : Promise.resolve(null),
    tab === 'parlays' ? loadGradedParlays() : Promise.resolve([] as GradedParlay[]),
    tab === 'streaks' ? loadStreakData()    : Promise.resolve(null as StreakData | null),
    // Always load daily breakdown from prop_results (same source as Model Performance on home page).
    // This bypasses snapshot staleness and the prop_grades 5000-row limit.
    tab === 'props' ? loadDailyBreakdownFromResults() : Promise.resolve(new Map<string, TierMap>()),
  ])

  const totals        = propsData?.totals        ?? null
  const days          = propsData?.days          ?? 0
  // Prefer live prop_results data; snapshot daily_breakdown only as last resort
  const dailyBreakdown = (dailyBreakdownLive as Map<string, TierMap>).size > 0
    ? (dailyBreakdownLive as Map<string, TierMap>)
    : propsData?.dailyBreakdown ?? new Map<string, TierMap>()
  const calibration   = propsData?.calibration   ?? null
  const hasData       = (totals?.ALL.total ?? 0) > 0

  const valueParlays   = gradedParlays.filter((p) => p.parlay_type === 'value')
  const comboParlays   = gradedParlays.filter((p) => p.parlay_type === 'combo')
  const premiumParlays = gradedParlays.filter((p) => p.parlay_type === 'premium')
  const jackpotParlays = gradedParlays.filter((p) => p.parlay_type === 'jackpot')

  const tabs = [
    { key: 'props',   label: 'Prop History' },
    { key: 'parlays', label: 'Parlays'      },
    { key: 'streaks', label: 'Streaks'      },
  ] as const

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 flex flex-col gap-10">

      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-black text-white tracking-tight">Model Performance</h1>
        <p className="text-white/35 text-sm">
          How many of Prizm&apos;s confidence picks actually hit — tracked daily.
        </p>
      </div>

      {/* Tab nav */}
      <div className="flex items-center gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1 w-fit">
        {tabs.map(({ key, label }) => (
          <a
            key={key}
            href={`/performance${key === 'props' ? '' : `?tab=${key}`}`}
            className={[
              'px-4 py-2 rounded-lg text-sm font-semibold transition-colors',
              tab === key
                ? 'bg-white/[0.08] text-white'
                : 'text-white/35 hover:text-white/60',
            ].join(' ')}
          >
            {label}
          </a>
        ))}
      </div>

      {/* ═══ PROP HISTORY TAB ═══ */}
      {tab === 'props' && (!hasData ? (
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
              All-time ({days} day{days !== 1 ? 's' : ''} tracked · {totals!.ALL.total} props graded)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(['LOCK', 'PLAY', 'LEAN', 'FADE', 'ALL'] as const).map((label) => {
                const t = totals![label]
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

          {/* ── OVER vs UNDER breakdown ── */}
          {calibration!.sampleSize >= 20 && (() => {
            const STAT_SHORT: Record<string, string> = { points: 'PTS', rebounds: 'REB', assists: 'AST', steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA' }
            const { over, under } = calibration!.byDirection
            const overRate  = over.total  > 0 ? over.hits  / over.total  : null
            const underRate = under.total > 0 ? under.hits / under.total : null
            const gap = overRate != null && underRate != null ? Math.round((underRate - overRate) * 100) : null
            const adjDiffers = calibration!.recommendedOverAdj !== calibration!.currentOverAdj

            return (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-white/35 uppercase tracking-widest">OVER vs UNDER</p>
                  <span className="text-[10px] text-white/20">{calibration!.sampleSize} graded props</span>
                </div>

                {/* Direction cards */}
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { dir: 'OVER',  d: over,  rate: overRate,  color: 'text-emerald-400', border: 'border-emerald-400/15', bg: 'bg-emerald-400/[0.03]' },
                    { dir: 'UNDER', d: under, rate: underRate, color: 'text-red-400',     border: 'border-red-400/15',     bg: 'bg-red-400/[0.03]'     },
                  ] as const).map(({ dir, d, rate, color, border, bg }) => (
                    <div key={dir} className={`rounded-2xl border ${border} ${bg} p-4 flex flex-col gap-1`}>
                      <span className={`text-[10px] font-black uppercase tracking-wider ${color}`}>{dir}</span>
                      <span className={`text-3xl font-black mt-1 ${rate != null && rate >= 0.55 ? 'text-emerald-400' : rate != null && rate >= 0.45 ? 'text-[#FFB800]' : 'text-red-400'}`}>
                        {rate != null ? `${Math.round(rate * 100)}%` : '—'}
                      </span>
                      <span className="text-xs text-white/25">{d.hits}/{d.total} hit</span>
                    </div>
                  ))}
                </div>

                {/* Gap + model note */}
                {gap != null && (
                  <div className={`rounded-xl border px-4 py-3 flex flex-col gap-1 ${adjDiffers ? 'border-[#FFB800]/20 bg-[#FFB800]/[0.03]' : 'border-white/[0.06] bg-white/[0.01]'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40">UNDER outperforms OVER by <span className="text-white/70 font-bold">{gap}pp</span></span>
                      <span className={`text-[10px] font-black ${adjDiffers ? 'text-[#FFB800]' : 'text-white/25'}`}>
                        {adjDiffers ? `Suggest ${calibration!.recommendedOverAdj > 0 ? '+' : ''}${calibration!.recommendedOverAdj}pt adj (current: ${calibration!.currentOverAdj})` : `Current ${calibration!.currentOverAdj}pt adj is calibrated ✓`}
                      </span>
                    </div>
                  </div>
                )}

                {/* By label: OVER vs UNDER hit rate */}
                <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/[0.05] flex items-center justify-between">
                    <span className="text-xs text-white/40 font-semibold">Hit Rate by Label</span>
                    <div className="flex items-center gap-4 text-[10px] text-white/25">
                      <span className="text-emerald-400">■ OVER</span>
                      <span className="text-red-400">■ UNDER</span>
                    </div>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as const).map((label) => {
                      const d = calibration!.byLabelDir[label]
                      if (!d) return null
                      const oRate = d.over.total  > 0 ? d.over.hits  / d.over.total  : null
                      const uRate = d.under.total > 0 ? d.under.hits / d.under.total : null
                      if (d.over.total + d.under.total === 0) return null
                      const c = TIER_COLORS[label]
                      return (
                        <div key={label} className="px-4 py-3 flex items-center gap-3">
                          <span className={`text-[10px] font-black w-10 shrink-0 px-1.5 py-0.5 rounded border text-center ${c.badge}`}>{label}</span>
                          <div className="flex-1 grid grid-cols-2 gap-3">
                            {([['OVER', oRate, d.over] , ['UNDER', uRate, d.under]] as [string, number | null, {hits:number;total:number}][]).map(([dir, rate, split]) => (
                              <div key={dir} className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                  <div className={`h-full rounded-full ${dir === 'OVER' ? 'bg-emerald-500' : 'bg-red-500'}`}
                                    style={{ width: rate != null ? `${Math.round(rate * 100)}%` : '0%' }} />
                                </div>
                                <span className="text-xs tabular-nums text-white/40 w-10 text-right">
                                  {rate != null ? `${Math.round(rate * 100)}%` : '—'}
                                </span>
                                <span className="text-[10px] text-white/20 w-12 text-right">{split.hits}/{split.total}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Stat type hit rates */}
                <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/[0.05]">
                    <span className="text-xs text-white/40 font-semibold">Hit Rate by Stat Type</span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {Object.entries(calibration!.byStatType)
                      .sort((a, b) => (b[1].total) - (a[1].total))
                      .map(([stat, d]) => {
                        if (d.total < 5) return null
                        const rate = d.hits / d.total
                        const pct  = Math.round(rate * 100)
                        return (
                          <div key={stat} className="px-4 py-2.5 flex items-center gap-3">
                            <span className="text-xs text-white/50 w-10 shrink-0">{STAT_SHORT[stat] ?? stat}</span>
                            <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${pct >= 60 ? 'bg-emerald-500' : pct >= 50 ? 'bg-[#FFB800]' : 'bg-red-500'}`}
                                style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs font-bold tabular-nums text-white/50 w-10 text-right">{pct}%</span>
                            <span className="text-[10px] text-white/20 w-14 text-right">{d.hits}/{d.total}</span>
                          </div>
                        )
                      })}
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ── Score calibration ── */}
          {calibration!.sampleSize >= 20 && (() => {
            const filledBuckets = calibration!.buckets.filter((b) => b.total >= 5)
            if (filledBuckets.length === 0) return null
            return (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-[11px] text-white/35 uppercase tracking-widest">Score Calibration</p>
                    <p className="text-[10px] text-white/20">Does score 70 actually mean 70% hit rate?</p>
                  </div>
                </div>
                <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/[0.05] grid grid-cols-4 text-[10px] text-white/25 font-semibold uppercase tracking-wider">
                    <span>Score</span>
                    <span className="text-center">Expected</span>
                    <span className="text-center">Actual</span>
                    <span className="text-right">Sample</span>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {calibration!.buckets.map((b) => {
                      if (b.total < 5) return (
                        <div key={b.label} className="px-4 py-2.5 grid grid-cols-4 items-center">
                          <span className="text-xs text-white/30">{b.label}</span>
                          <span className="text-center text-xs text-white/15">—</span>
                          <span className="text-center text-xs text-white/15">—</span>
                          <span className="text-right text-[10px] text-white/15">{b.total} props</span>
                        </div>
                      )
                      const expected = Math.round((b.min + b.max) / 2)
                      const actual   = Math.round((b.hits / b.total) * 100)
                      const delta    = actual - expected
                      const deltaColor = Math.abs(delta) <= 5 ? 'text-emerald-400'
                        : Math.abs(delta) <= 12 ? 'text-[#FFB800]' : 'text-red-400'
                      return (
                        <div key={b.label} className="px-4 py-2.5 grid grid-cols-4 items-center">
                          <span className="text-xs text-white/60 font-semibold">{b.label}</span>
                          <span className="text-center text-xs text-white/30">{expected}%</span>
                          <div className="flex items-center justify-center gap-1.5">
                            <span className={`text-xs font-bold ${deltaColor}`}>{actual}%</span>
                            {delta !== 0 && (
                              <span className={`text-[10px] ${deltaColor}`}>
                                {delta > 0 ? `+${delta}` : delta}
                              </span>
                            )}
                          </div>
                          <span className="text-right text-[10px] text-white/20">{b.total} props</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <p className="text-[10px] text-white/20 leading-relaxed">
                  Delta = actual − expected. Green (≤5pp) = well calibrated. Yellow = slight overconfidence.
                  Red (&gt;12pp) = model is overconfident at this score range and thresholds may need adjustment.
                </p>
              </div>
            )
          })()}

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
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-[#6C5CE7]/30 to-transparent" />
                  <div className="p-5 flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <p className="font-bold text-white/70">{formatDate(date)}</p>
                      {overallPct !== null && (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-white/30">Overall</span>
                          <span className={`text-sm font-black ${overallPct >= 65 ? 'text-emerald-400' : overallPct >= 55 ? 'text-[#FFB800]' : 'text-red-400'}`}>
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
      ))}

      {/* ═══ STREAKS TAB ═══ */}
      {tab === 'streaks' && streakData && (() => {
        const { currentStreak, longestStreak, totalDays, hitRate, currentStreakPicks, allHistory } = streakData
        const STAT_SHORT: Record<string, string> = { points: 'PTS', rebounds: 'REB', assists: 'AST', steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA' }

        // Build 10-bar tracker: hits fill from the RIGHT, today's pending sits
        // just after the last hit, empty bars fill the LEFT.
        const TOTAL = 10
        const todayEntry = allHistory[0]
        const todayState: 'pending' | 'hit' | 'empty' =
          todayEntry?.isPending ? 'pending'
          : todayEntry?.result === 'hit' ? 'hit'
          : 'empty'

        let streakHits = 0
        for (const e of allHistory) {
          if (e.isPending) continue
          if (e.result !== 'hit') break
          streakHits++
          if (streakHits >= TOTAL) break
        }

        const hasToday = todayState !== 'empty' ? 1 : 0
        const filledCount = Math.min(streakHits + hasToday, TOTAL)
        const emptyCount  = TOTAL - filledCount

        const bubbles: Array<'hit' | 'miss' | 'pending' | 'empty'> = []
        for (let i = 0; i < Math.min(streakHits, TOTAL - hasToday); i++) bubbles.push('hit')
        if (hasToday) bubbles.push(todayState)
        for (let i = 0; i < emptyCount; i++) bubbles.push('empty')

        return (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <p className="text-[11px] text-white/35 uppercase tracking-widest">Daily Streak</p>
              </div>
              <span className="text-[10px] text-white/20">{totalDays} day{totalDays !== 1 ? 's' : ''} tracked</span>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Current Streak', value: currentStreak > 0 ? `${currentStreak}` : '0', color: currentStreak >= 3 ? 'text-emerald-400' : currentStreak > 0 ? 'text-[#FFB800]' : 'text-white/50', glow: currentStreak >= 3 ? 'shadow-[0_0_12px_rgba(16,185,129,0.2)]' : '' },
                { label: 'Longest Streak', value: `${longestStreak}`, color: 'text-[#6C5CE7]', glow: longestStreak >= 3 ? 'shadow-[0_0_12px_rgba(108,92,231,0.2)]' : '' },
                { label: 'Hit Rate', value: hitRate !== null ? `${Math.round(hitRate * 100)}%` : '—', color: hitRate !== null && hitRate >= 0.6 ? 'text-emerald-400' : hitRate !== null ? 'text-[#FFB800]' : 'text-white/50', glow: '' },
                { label: 'Days Tracked', value: `${totalDays}`, color: 'text-white/70', glow: '' },
              ].map(({ label, value, color, glow }) => (
                <div key={label} className={`rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-1 ${glow}`}>
                  <span className="text-[10px] font-black uppercase tracking-wider text-white/30">{label}</span>
                  <span className={`text-3xl font-black mt-1 ${color}`}>{value}</span>
                </div>
              ))}
            </div>

            {/* 10-bubble tracker */}
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/30 font-semibold">Streak Progress</span>
                <span className="text-[10px] text-white/20">last 10 days · 1 pick each</span>
              </div>
              <div className="flex items-center gap-2">
                {bubbles.map((state, i) => (
                  <div
                    key={i}
                    className={`flex-1 h-4 rounded-full transition-all ${
                      state === 'hit'     ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                      : state === 'miss' ? 'bg-red-400'
                      : state === 'pending' ? 'bg-orange-400 animate-pulse'
                      : 'bg-white/[0.08]'
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                {[
                  { color: 'bg-emerald-400', label: 'Hit' },
                  { color: 'bg-red-400',     label: 'Miss' },
                  { color: 'bg-orange-400 animate-pulse', label: 'Pending' },
                  { color: 'bg-white/[0.08]', label: 'Empty' },
                ].map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-1.5">
                    <div className={`w-2.5 h-2.5 rounded-full ${color}`} />
                    <span className="text-[10px] text-white/30">{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Current streak picks */}
            {currentStreakPicks.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-white/25 uppercase tracking-widest">
                  {currentStreak > 0 ? `Current Streak · ${currentStreak} day${currentStreak !== 1 ? 's' : ''}` : 'Today\'s Pick'}
                </p>
                {currentStreakPicks.map((entry) => (
                  <div key={entry.id} className={`rounded-2xl border overflow-hidden ${entry.isPending ? 'border-orange-400/20 bg-orange-400/[0.03]' : 'border-emerald-400/20 bg-emerald-400/[0.03]'}`}>
                    <div className="px-4 py-2.5 flex items-center justify-between border-b border-white/[0.05]">
                      <span className="text-xs text-white/50 font-semibold">{formatDate(entry.game_date)}</span>
                      <span className={`text-[10px] font-black uppercase ${entry.isPending ? 'text-orange-400' : 'text-emerald-400'}`}>
                        {entry.isPending ? '⏳ Pending' : '✓ Hit'}
                      </span>
                    </div>
                    <div className="px-4 py-3 flex flex-col gap-2">
                      {entry.legs.map((leg, i) => (
                        <div key={i} className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${leg.hit === null ? 'bg-orange-400 animate-pulse' : leg.hit ? 'bg-emerald-400' : 'bg-red-400'}`} />
                            <span className="text-sm text-white/70 font-medium truncate">{leg.player_name}</span>
                            <span className="text-xs text-white/35 shrink-0">
                              {leg.direction === 'over' ? 'O' : 'U'}{leg.line} {STAT_SHORT[leg.stat_type] ?? leg.stat_type}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {leg.actual !== null && (
                              <span className="text-xs font-mono text-white/30">actual: {leg.actual}</span>
                            )}
                            <span className={`text-xs font-bold ${leg.hit === null ? 'text-orange-400' : leg.hit ? 'text-emerald-400' : 'text-red-400'}`}>
                              {leg.hit === null ? '—' : leg.hit ? '✓' : '✗'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Full history */}
            {allHistory.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-white/25 uppercase tracking-widest">Full History</p>
                {allHistory.map((entry) => {
                  const statusColor = entry.isPending ? 'text-orange-400' : entry.result === 'hit' ? 'text-emerald-400' : entry.result === 'miss' ? 'text-red-400' : 'text-white/25'
                  const statusText  = entry.isPending ? 'PENDING' : entry.result === 'hit' ? 'HIT' : entry.result === 'miss' ? 'MISS' : 'VOID'
                  const dotColor    = entry.isPending ? 'bg-orange-400 animate-pulse' : entry.result === 'hit' ? 'bg-emerald-400' : entry.result === 'miss' ? 'bg-red-400' : 'bg-white/20'

                  return (
                    <details key={entry.id} className="group rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                      <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none hover:bg-white/[0.02] transition-colors list-none">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
                          <span className="text-sm font-semibold text-white/60 truncate">
                            {entry.legs.map((l) => l.player_name).join(' · ')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-xs text-white/25">{formatDate(entry.game_date)}</span>
                          <span className={`text-xs font-black ${statusColor}`}>{statusText}</span>
                        </div>
                      </summary>
                      <div className="border-t border-white/[0.05] px-4 py-3 flex flex-col gap-1.5">
                        {entry.legs.map((leg, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 py-0.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-xs text-white/50 truncate">{leg.player_name}</span>
                              <span className="text-xs text-white/25 shrink-0">
                                {leg.direction === 'over' ? 'O' : 'U'}{leg.line} {STAT_SHORT[leg.stat_type] ?? leg.stat_type}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {leg.actual !== null && (
                                <span className="text-xs font-mono text-white/30">actual: {leg.actual}</span>
                              )}
                              <span className={`text-xs font-bold ${leg.hit === null ? 'text-white/20' : leg.hit ? 'text-emerald-400' : 'text-red-400'}`}>
                                {leg.hit === null ? (entry.isPending ? '—' : 'VOID') : leg.hit ? '✓' : '✗'}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )
                })}
              </div>
            )}

            {totalDays === 0 && (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.01] p-8 text-center">
                <p className="text-sm text-white/25">No streak data yet — picks appear after games are scheduled</p>
              </div>
            )}
          </div>
        )
      })()}

      {/* ═══ PARLAYS TAB ═══ */}
      {tab === 'parlays' && ([
        { label: 'Safe Picks',  sublabel: '2-leg · Safe stats · 24+ min · ~41% hit rate',           parlays: valueParlays,   accent: 'text-emerald-400', dot: 'bg-emerald-400', minHitPct: 35 },
        { label: 'Combo',      sublabel: '3-leg · Best ROI tier · ~19% hit rate · ~4x payout',   parlays: comboParlays,   accent: 'text-cyan-400',    dot: 'bg-cyan-400',    minHitPct: 15 },
        { label: 'High Roller', sublabel: '4-leg · 24+ min avg · ~16% hit rate · ~6x payout',    parlays: premiumParlays, accent: 'text-[#FFB800]',   dot: 'bg-[#FFB800]',   minHitPct: 12 },
        { label: 'Jackpot',     sublabel: '5-leg · 24+ min avg · ~8% hit rate · ~11x payout',    parlays: jackpotParlays, accent: 'text-[#6C5CE7]', dot: 'bg-[#6C5CE7]', minHitPct: 5 },
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
                    { stat: 'Pending',         value: String(parlays.filter((p) => p.is_pending).length), sub: 'awaiting results', color: 'text-[#FFB800]' },
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
                    const statusColor = parlay.is_pending ? 'text-[#FFB800]'
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
                            {parlay.pass === 2 && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border text-amber-400 bg-amber-400/10 border-amber-400/25 shrink-0">UPDATED</span>
                            )}
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

                          {/* Original morning pick (for Pass 2 updated parlays) */}
                          {parlay.pass === 2 && parlay.original_legs && parlay.original_legs.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-white/[0.05]">
                              <div className="flex items-center gap-2 mb-2 flex-wrap">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25">Original Morning Pick</span>
                                {parlay.change_summary && (
                                  <span className="text-[10px] text-amber-400/60 italic">{parlay.change_summary}</span>
                                )}
                                <span className={`text-[10px] font-bold ml-auto ${
                                  parlay.original_hit === null ? 'text-white/20'
                                  : parlay.original_hit ? 'text-emerald-400/60' : 'text-red-400/60'
                                }`}>
                                  {parlay.original_hit === null ? 'VOID' : parlay.original_hit ? 'WOULD HAVE HIT' : 'WOULD HAVE MISSED'}
                                </span>
                              </div>
                              {parlay.original_legs.map((leg, i) => (
                                <div key={i} className="flex items-center justify-between gap-2 py-0.5 opacity-50">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[11px] text-white/40 truncate line-through">{leg.player_name}</span>
                                    <span className="text-[11px] text-white/20 shrink-0">
                                      {leg.direction === 'over' ? 'O' : 'U'}{leg.line} {STAT_SHORT[leg.stat_type] ?? leg.stat_type}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {leg.actual !== null && (
                                      <span className="text-[11px] font-mono text-white/20">actual: {leg.actual}</span>
                                    )}
                                    <span className={`text-[11px] font-bold ${leg.hit === null ? 'text-white/15' : leg.hit ? 'text-emerald-400/50' : 'text-red-400/50'}`}>
                                      {leg.hit === null ? 'VOID' : leg.hit ? '\u2713' : '\u2717'}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
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
