// /api/backtest/multi-parlay
//
// Backtests the 3-parlays-per-day strategy across all historical dates.
// Mirrors the live generator logic exactly:
//   · Build a sorted pool of LOCK/PLAY OVER props by confidence_score desc
//   · Dedup pool to best prop per player|stat
//   · Greedily pick LEGS_PER legs per parlay, no player repeat within a parlay
//   · Global uniqueness: each player|stat prop used only once across all parlays
//   · Stake = 5 units per parlay
//   · Hit = all legs hit; profit = 5 × parlayDecimal − 5; miss = −5
//
// Runs multiple configurations to find the optimal setup:
//   · parlays_per_day:  1 | 2 | 3
//   · legs_per_parlay:  3 | 4
//   · markets:          pts_reb_3pm | pts_reb_ast_3pm | pts_reb_ast | pts_reb | all_no_volatile
//   · tiers:            LOCK+PLAY | LOCK+PLAY+LEAN

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const maxDuration = 120

const STAKE = 5

const MARKET_FILTERS: Record<string, string[]> = {
  pts_reb_3pm:      ['points', 'rebounds', 'three_pointers'],
  pts_reb_ast_3pm:  ['points', 'rebounds', 'assists', 'three_pointers'],
  pts_reb_ast:      ['points', 'rebounds', 'assists'],
  pts_reb:          ['points', 'rebounds'],
  no_volatile:      ['points', 'rebounds', 'assists', 'pra', 'three_pointers'],
}

interface Config {
  id:              string
  label:           string
  parlaysPerDay:   number
  legsPerParlay:   number
  markets:         keyof typeof MARKET_FILTERS
  tiers:           string[]
}

const CONFIGS: Config[] = []
for (const ppd of [1, 2, 3] as const) {
  for (const lpp of [3, 4] as const) {
    for (const market of Object.keys(MARKET_FILTERS) as (keyof typeof MARKET_FILTERS)[]) {
      for (const tiers of [['LOCK','PLAY'], ['LOCK','PLAY','LEAN']] as const) {
        const tierLabel = tiers.includes('LEAN') ? 'LOCK+PLAY+LEAN' : 'LOCK+PLAY'
        CONFIGS.push({
          id:            `${ppd}p_${lpp}l_${market}_${tierLabel.replace(/\+/g,'_')}`,
          label:         `${ppd} parlays/day · ${lpp}-leg · ${market} · ${tierLabel}`,
          parlaysPerDay: ppd,
          legsPerParlay: lpp,
          markets:       market,
          tiers:         [...tiers],
        })
      }
    }
  }
}

interface GradeRow {
  game_date:        string
  player_name:      string
  stat_type:        string
  line:             number
  direction:        string
  confidence_label: string
  confidence_score: number
  hit:              boolean | null
}

interface HistRow {
  game_date:   string
  player_name: string
  stat_type:   string
  direction:   string
  line:        number
  odds:        number | null
}

interface LogRow {
  player_name: string
  game_date:   string
  minutes:     number | null
}

function toDecimal(odds: number | null): number {
  if (odds == null) return 100 / 130 + 1  // default -130 (conservative avg prop odds)
  if (odds > 0) return odds / 100 + 1
  return 100 / Math.abs(odds) + 1
}

interface ScoredProp extends GradeRow {
  odds:     number | null
  avgMins:  number | null   // avg minutes per game (prior games only, no lookahead)
}

interface ParlayLeg {
  player_name: string
  stat_type:   string
  hit:         boolean | null
  odds:        number | null
}

function pickLegs(
  pool:         ScoredProp[],
  globalUsed:   Set<string>,
  legsNeeded:   number,
  allowOverlap: boolean,   // if true, ignore globalUsed (shared pool with another parlay set)
  minMins:      number = 0, // minimum avg minutes filter (0 = no filter)
): ParlayLeg[] | null {
  const legs: ParlayLeg[] = []
  const usedPlayers = new Set<string>()

  for (const prop of pool) {
    if (legs.length >= legsNeeded) break
    const key = `${prop.player_name}|${prop.stat_type}`
    if (!allowOverlap && globalUsed.has(key)) continue
    if (usedPlayers.has(prop.player_name)) continue
    if (minMins > 0 && (prop.avgMins == null || prop.avgMins < minMins)) continue

    legs.push({ player_name: prop.player_name, stat_type: prop.stat_type, hit: prop.hit, odds: prop.odds })
    usedPlayers.add(prop.player_name)
  }

  if (legs.length < legsNeeded) return null
  return legs
}

function buildParlays(
  dayProps: ScoredProp[],
  config:   Config,
  minMins:  number = 0,
): ParlayLeg[][] {
  const allowedMarkets = new Set(MARKET_FILTERS[config.markets])
  const allowedTiers   = new Set(config.tiers)

  const pool = dayProps
    .filter((p) => allowedMarkets.has(p.stat_type))
    .filter((p) => allowedTiers.has(p.confidence_label))
    .filter((p) => p.hit !== null)
    .sort((a, b) => b.confidence_score - a.confidence_score)

  const parlays: ParlayLeg[][] = []
  const globalUsed = new Set<string>()

  for (let i = 0; i < config.parlaysPerDay; i++) {
    const legs = pickLegs(pool, globalUsed, config.legsPerParlay, false, minMins)
    if (!legs) break
    for (const leg of legs) globalUsed.add(`${leg.player_name}|${leg.stat_type}`)
    parlays.push(legs)
  }

  return parlays
}

// Hybrid: 1×3-leg anchor parlay + N×4-leg parlays with independent pools
// The 3-leg and 4-leg groups each maintain their own globalUsed —
// so a player|stat can appear in both the 3-leg and a 4-leg.
function buildHybridParlays(
  dayProps:     ScoredProp[],
  markets:      keyof typeof MARKET_FILTERS,
  tiers:        string[],
  fourLegCount: number,
  minMins:      number = 0,
): ParlayLeg[][] {
  const allowedMarkets = new Set(MARKET_FILTERS[markets])
  const allowedTiers   = new Set(tiers)

  const pool = dayProps
    .filter((p) => allowedMarkets.has(p.stat_type))
    .filter((p) => allowedTiers.has(p.confidence_label))
    .filter((p) => p.hit !== null)
    .sort((a, b) => b.confidence_score - a.confidence_score)

  const results: ParlayLeg[][] = []

  const anchorUsed = new Set<string>()
  const anchor = pickLegs(pool, anchorUsed, 3, false, minMins)
  if (!anchor) return []
  for (const leg of anchor) anchorUsed.add(`${leg.player_name}|${leg.stat_type}`)
  results.push(anchor)

  const fourLegUsed = new Set<string>()
  for (let i = 0; i < fourLegCount; i++) {
    const legs = pickLegs(pool, fourLegUsed, 4, false, minMins)
    if (!legs) break
    for (const leg of legs) fourLegUsed.add(`${leg.player_name}|${leg.stat_type}`)
    results.push(legs)
  }

  return results
}

interface DayResult {
  date:      string
  parlays:   { legs: string[]; hit: boolean; profit: number; decimal: number }[]
  totalProfit: number
}

interface ConfigResult {
  id:                    string
  label:                 string
  parlaysPerDay:         number
  legsPerParlay:         number
  markets:               string
  tiers:                 string[]
  daysPlayed:            number      // days where full set of parlays was built
  totalParlays:          number
  totalHits:             number
  hitRate:               number | null
  avgOddsMultiplier:     number
  totalStaked:           number
  totalProfit:           number
  roi:                   number | null
  profitPerDay:          number
  perDate:               DayResult[]
}

const REAL_START = '2026-02-04'   // first date with real sportsbook prop lines
const SYNTH_END  = '2026-02-03'   // last date with synthetic-only prop lines

export async function GET(req: Request) {
  const url          = new URL(req.url)
  const configFilter = url.searchParams.get('config')              // e.g. "3p_4l_pts_reb_3pm_LOCK_PLAY"
  const partial      = url.searchParams.get('partial') === 'true'  // play partial days
  const source       = url.searchParams.get('source') ?? 'combined' // real | synthetic | combined | all
  // ── 1. Load prop_grades ────────────────────────────────────────────────────
  const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const grades: GradeRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('prop_grades')
        .select('game_date, player_name, stat_type, line, direction, confidence_label, confidence_score, hit')
        .not('confidence_label', 'is', null)
        .eq('direction', 'over')
        .lt('game_date', today)
        .order('game_date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) grades.push(row as GradeRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  if (grades.length === 0) {
    return NextResponse.json({ error: 'No graded prop data found' }, { status: 400 })
  }

  // ── 2. Load prop_history for odds ──────────────────────────────────────────
  const histMap = new Map<string, number | null>()
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('prop_history')
        .select('game_date, player_name, stat_type, direction, line, odds')
        .eq('direction', 'over')
        .lt('game_date', today)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) {
        const r = row as HistRow
        const key = `${r.player_name}|${r.stat_type}|${r.game_date}`
        if (!histMap.has(key)) histMap.set(key, r.odds)
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // ── 3. Load player_game_logs for per-player avg minutes (no lookahead) ───────
  // For each player+date we need avg minutes from games BEFORE that date.
  // Store logs as { player_name → [ {game_date, minutes}, ... ] } sorted asc.
  const logsByPlayer = new Map<string, { date: string; mins: number }[]>()
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, minutes')
        .not('minutes', 'is', null)
        .order('game_date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) {
        const r = row as LogRow
        if (!logsByPlayer.has(r.player_name)) logsByPlayer.set(r.player_name, [])
        logsByPlayer.get(r.player_name)!.push({ date: r.game_date, mins: r.minutes ?? 0 })
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // Pre-compute avg minutes up to (not including) each game date per player.
  // Use last 20 prior games for the rolling average.
  const avgMinsCache = new Map<string, number | null>()  // "player|date" → avg mins
  function getAvgMins(player: string, beforeDate: string): number | null {
    const cacheKey = `${player}|${beforeDate}`
    if (avgMinsCache.has(cacheKey)) return avgMinsCache.get(cacheKey)!
    const logs = logsByPlayer.get(player) ?? []
    const prior = logs.filter((l) => l.date < beforeDate).slice(-20)
    if (prior.length === 0) { avgMinsCache.set(cacheKey, null); return null }
    const avg = prior.reduce((s, l) => s + l.mins, 0) / prior.length
    avgMinsCache.set(cacheKey, avg)
    return avg
  }

  // ── 4. Annotate grades with odds + avgMins, dedup to best per player|stat|date
  const rawAnnotated: ScoredProp[] = grades.map((g) => ({
    ...g,
    odds:    histMap.get(`${g.player_name}|${g.stat_type}|${g.game_date}`) ?? null,
    avgMins: getAvgMins(g.player_name, g.game_date),
  }))

  // Dedup: keep highest confidence per player|stat|date
  const dedupMap = new Map<string, ScoredProp>()
  for (const p of rawAnnotated) {
    const key = `${p.player_name}|${p.stat_type}|${p.game_date}`
    const ex  = dedupMap.get(key)
    if (!ex || p.confidence_score > ex.confidence_score) dedupMap.set(key, p)
  }
  const annotated = [...dedupMap.values()]

  // Group by date
  const byDate = new Map<string, ScoredProp[]>()
  for (const p of annotated) {
    if (!byDate.has(p.game_date)) byDate.set(p.game_date, [])
    byDate.get(p.game_date)!.push(p)
  }
  const allDates   = [...byDate.keys()].sort()
  const realDates  = allDates.filter((d) => d >= REAL_START)
  const synthDates = allDates.filter((d) => d <= SYNTH_END)

  // Apply source filter for the main backtest run
  const sortedDates =
    source === 'real'      ? realDates :
    source === 'synthetic' ? synthDates : allDates

  // ── 4. Run each config ─────────────────────────────────────────────────────
  const configsToRun = configFilter ? CONFIGS.filter((c) => c.id === configFilter) : CONFIGS
  const results: ConfigResult[] = configsToRun.map((config) => {
    let daysPlayed = 0, totalParlays = 0, totalHits = 0
    let totalStaked = 0, totalProfit = 0, totalDecimal = 0
    const perDate: DayResult[] = []

    for (const date of sortedDates) {
      const dayProps = byDate.get(date) ?? []
      const parlays  = buildParlays(dayProps, config)

      if (parlays.length === 0) continue                               // no parlays at all — skip
      if (!partial && parlays.length < config.parlaysPerDay) continue  // strict: require full set

      daysPlayed++
      let dayProfit = 0
      const dayParlays: DayResult['parlays'] = []

      for (const legs of parlays) {
        totalParlays++
        totalStaked += STAKE

        const decimals     = legs.map((l) => toDecimal(l.odds))
        const parlayDec    = decimals.reduce((acc, d) => acc * d, 1)
        totalDecimal      += parlayDec

        const hit    = legs.every((l) => l.hit === true)
        const profit = hit ? STAKE * parlayDec - STAKE : -STAKE
        if (hit) totalHits++
        totalProfit += profit
        dayProfit   += profit

        dayParlays.push({
          legs:    legs.map((l) => `${l.player_name} ${l.stat_type}`),
          hit,
          profit:  Math.round(profit * 100) / 100,
          decimal: Math.round(parlayDec * 100) / 100,
        })
      }

      perDate.push({ date, parlays: dayParlays, totalProfit: Math.round(dayProfit * 100) / 100 })
    }

    const hitRate = totalParlays > 0 ? Math.round(totalHits / totalParlays * 1000) / 10 : null
    const roi     = totalStaked  > 0 ? Math.round(totalProfit / totalStaked * 1000) / 10 : null

    return {
      id:                config.id,
      label:             config.label,
      parlaysPerDay:     config.parlaysPerDay,
      legsPerParlay:     config.legsPerParlay,
      markets:           config.markets,
      tiers:             config.tiers,
      daysPlayed,
      totalParlays,
      totalHits,
      hitRate,
      avgOddsMultiplier: totalParlays > 0 ? Math.round(totalDecimal / totalParlays * 100) / 100 : 0,
      totalStaked:       Math.round(totalStaked * 100) / 100,
      totalProfit:       Math.round(totalProfit * 100) / 100,
      roi,
      profitPerDay:      daysPlayed > 0 ? Math.round(totalProfit / daysPlayed * 100) / 100 : 0,
      perDate,
    }
  })

  // Sort by ROI descending
  results.sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999))

  // ── 5. Summary tables ──────────────────────────────────────────────────────
  // Best per parlays_per_day setting
  const bestByPpd: Record<number, ConfigResult> = {}
  for (const r of results) {
    if (!bestByPpd[r.parlaysPerDay] || (r.roi ?? -999) > (bestByPpd[r.parlaysPerDay].roi ?? -999)) {
      bestByPpd[r.parlaysPerDay] = r
    }
  }

  // Market hit rates (flat, across all configs using LOCK+PLAY 3-leg 1-parlay)
  const baseConfig = results.find((r) => r.parlaysPerDay === 1 && r.legsPerParlay === 3 && !r.tiers.includes('LEAN'))
  const marketSummary: Record<string, { total: number; hits: number; hitRate: number | null }> = {}
  if (baseConfig) {
    for (const date of baseConfig.perDate) {
      for (const parlay of date.parlays) {
        for (const legLabel of parlay.legs) {
          // legLabel = "PlayerName stat_type"
          const parts    = legLabel.split(' ')
          const statType = parts[parts.length - 1]
          if (!marketSummary[statType]) marketSummary[statType] = { total: 0, hits: 0, hitRate: null }
          marketSummary[statType].total++
          if (parlay.hit) marketSummary[statType].hits++
        }
      }
    }
    for (const stat of Object.keys(marketSummary)) {
      const s = marketSummary[stat]
      s.hitRate = s.total > 0 ? Math.round(s.hits / s.total * 1000) / 10 : null
    }
  }

  // ── 6. Hybrid backtest: 1×3-leg + 3×4-leg, PTS/REB/3PM, LOCK+PLAY, strict ──
  const hybridMarkets: keyof typeof MARKET_FILTERS = 'pts_reb_3pm'
  const hybridTiers   = ['LOCK', 'PLAY']
  const REQUIRED_4LEG = 3  // need all 3 four-leg parlays + the anchor to play the day

  let h_days = 0, h_parlays = 0, h_hits = 0
  let h_staked = 0, h_profit = 0, h_decimal = 0
  const h_perDate: DayResult[] = []

  for (const date of sortedDates) {
    const dayProps = byDate.get(date) ?? []
    const parlays  = buildHybridParlays(dayProps, hybridMarkets, hybridTiers, REQUIRED_4LEG)

    // Require: 1 anchor (3-leg) + REQUIRED_4LEG four-leg parlays = REQUIRED_4LEG + 1 total
    if (parlays.length < REQUIRED_4LEG + 1) continue

    h_days++
    let dayProfit = 0
    const dayParlays: DayResult['parlays'] = []

    for (const legs of parlays) {
      h_parlays++
      h_staked += STAKE

      const decimals  = legs.map((l) => toDecimal(l.odds))
      const parlayDec = decimals.reduce((acc, d) => acc * d, 1)
      h_decimal      += parlayDec

      const hit    = legs.every((l) => l.hit === true)
      const profit = hit ? STAKE * parlayDec - STAKE : -STAKE
      if (hit) h_hits++
      h_profit  += profit
      dayProfit += profit

      dayParlays.push({
        legs:    legs.map((l) => `${l.player_name} ${l.stat_type}`),
        hit,
        profit:  Math.round(profit * 100) / 100,
        decimal: Math.round(parlayDec * 100) / 100,
      })
    }

    h_perDate.push({ date, parlays: dayParlays, totalProfit: Math.round(dayProfit * 100) / 100 })
  }

  const hybridResult = {
    label:             '1x3-leg anchor + 3x4-leg · pts_reb_3pm · LOCK+PLAY (strict)',
    daysPlayed:        h_days,
    totalParlays:      h_parlays,
    totalHits:         h_hits,
    hitRate:           h_parlays > 0 ? Math.round(h_hits / h_parlays * 1000) / 10 : null,
    avgOddsMultiplier: h_parlays > 0 ? Math.round(h_decimal / h_parlays * 100) / 100 : 0,
    totalStaked:       Math.round(h_staked * 100) / 100,
    totalProfit:       Math.round(h_profit * 100) / 100,
    roi:               h_staked > 0 ? Math.round(h_profit / h_staked * 1000) / 10 : null,
    profitPerDay:      h_days > 0 ? Math.round(h_profit / h_days * 100) / 100 : 0,
    stakePerDay:       (REQUIRED_4LEG + 1) * STAKE,
    perDate:           h_perDate,
  }

  // ── 7. Minutes threshold sweep ─────────────────────────────────────────────
  // Test the two live configs (value 1×3-leg and premium 3×4-leg) across
  // min-minutes thresholds to find the optimal player-quality filter.
  const MIN_THRESHOLDS = [0, 18, 20, 22, 24, 26, 28, 30, 32]

  function runMinSweep(parlaysPerDay: number, legsPerParlay: number, label: string) {
    return MIN_THRESHOLDS.map((minMins) => {
      const config: Config = {
        id:            `sweep_${parlaysPerDay}p_${legsPerParlay}l_${minMins}m`,
        label:         `${label} · min ${minMins}+ mins`,
        parlaysPerDay, legsPerParlay,
        markets:       'pts_reb_3pm',
        tiers:         ['LOCK', 'PLAY'],
      }
      let days = 0, parlays = 0, hits = 0, staked = 0, profit = 0, decimal = 0
      for (const date of sortedDates) {
        const dayProps = byDate.get(date) ?? []
        const built    = buildParlays(dayProps, config, minMins)
        if (built.length < parlaysPerDay) continue
        days++
        for (const legs of built) {
          parlays++; staked += STAKE
          const dec = legs.map((l) => toDecimal(l.odds)).reduce((a, d) => a * d, 1)
          decimal += dec
          const hit = legs.every((l) => l.hit === true)
          const p   = hit ? STAKE * dec - STAKE : -STAKE
          if (hit) hits++
          profit += p
        }
      }
      return {
        minMins,
        daysPlayed:    days,
        totalParlays:  parlays,
        totalHits:     hits,
        hitRate:       parlays > 0 ? Math.round(hits / parlays * 1000) / 10 : null,
        avgMultiplier: parlays > 0 ? Math.round(decimal / parlays * 100) / 100 : 0,
        totalStaked:   Math.round(staked * 100) / 100,
        totalProfit:   Math.round(profit * 100) / 100,
        roi:           staked > 0 ? Math.round(profit / staked * 1000) / 10 : null,
        profitPerDay:  days > 0 ? Math.round(profit / days * 100) / 100 : 0,
      }
    })
  }

  const minutesSweep = {
    value:   runMinSweep(1, 3, '1×3-leg value'),
    premium: runMinSweep(3, 4, '3×4-leg premium'),
  }

  // ── 8. Markets × minutes cross-sweep (focus thresholds: 0, 24, 32) ──────────
  // For each market filter × key minute threshold, run 1×3-leg and 3×4-leg.
  const KEY_THRESHOLDS = [0, 24, 32]
  const ALL_MARKETS    = Object.keys(MARKET_FILTERS) as (keyof typeof MARKET_FILTERS)[]

  function sweepMarketsAt(parlaysPerDay: number, legsPerParlay: number) {
    return ALL_MARKETS.flatMap((market) =>
      KEY_THRESHOLDS.map((minMins) => {
        const config: Config = {
          id: `mkt_${parlaysPerDay}p_${legsPerParlay}l_${market}_${minMins}m`,
          label: `${parlaysPerDay}×${legsPerParlay}-leg · ${market} · ${minMins}+ mins`,
          parlaysPerDay, legsPerParlay,
          markets: market,
          tiers: ['LOCK', 'PLAY'],
        }
        let days = 0, parlays = 0, hits = 0, staked = 0, profit = 0
        for (const date of sortedDates) {
          const built = buildParlays(byDate.get(date) ?? [], config, minMins)
          if (built.length < parlaysPerDay) continue
          days++
          for (const legs of built) {
            parlays++; staked += STAKE
            const dec = legs.map((l) => toDecimal(l.odds)).reduce((a, d) => a * d, 1)
            const hit = legs.every((l) => l.hit === true)
            const p   = hit ? STAKE * dec - STAKE : -STAKE
            if (hit) hits++
            profit += p
          }
        }
        return {
          market,
          minMins,
          daysPlayed:   days,
          totalParlays: parlays,
          totalHits:    hits,
          hitRate:      parlays > 0 ? Math.round(hits / parlays * 1000) / 10 : null,
          totalStaked:  Math.round(staked * 100) / 100,
          totalProfit:  Math.round(profit * 100) / 100,
          roi:          staked > 0 ? Math.round(profit / staked * 1000) / 10 : null,
          profitPerDay: days > 0 ? Math.round(profit / days * 100) / 100 : 0,
        }
      })
    ).sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999))
  }

  const marketsMinutesSweep = {
    value:   sweepMarketsAt(1, 3),
    premium: sweepMarketsAt(3, 4),
  }

  // ── 9. Structure sweep: all counts × all leg sizes, both 0 and 24+ min filter ─
  // Tests every combo of parlaysPerDay ∈ [1..4] × legsPerParlay ∈ [2..6]
  // at min_mins ∈ [0, 24], markets=pts_reb_3pm, tiers=LOCK+PLAY.
  const PARLAY_COUNTS = [1, 2, 3, 4]
  const LEG_SIZES     = [2, 3, 4, 5, 6]
  const STRUCT_MINS   = [0, 24]

  const structureSweep = PARLAY_COUNTS.flatMap((ppd) =>
    LEG_SIZES.flatMap((lpp) =>
      STRUCT_MINS.map((minMins) => {
        const config: Config = {
          id: `struct_${ppd}p_${lpp}l_${minMins}m`,
          label: `${ppd}×${lpp}-leg · ${minMins}+ mins`,
          parlaysPerDay: ppd, legsPerParlay: lpp,
          markets: 'pts_reb_3pm', tiers: ['LOCK', 'PLAY'],
        }
        let days = 0, parlays = 0, hits = 0, staked = 0, profit = 0, decimal = 0
        for (const date of sortedDates) {
          const built = buildParlays(byDate.get(date) ?? [], config, minMins)
          if (built.length < ppd) continue
          days++
          for (const legs of built) {
            parlays++; staked += STAKE
            const dec = legs.map((l) => toDecimal(l.odds)).reduce((a, d) => a * d, 1)
            decimal += dec
            const hit = legs.every((l) => l.hit === true)
            const p   = hit ? STAKE * dec - STAKE : -STAKE
            if (hit) hits++
            profit += p
          }
        }
        const stakePerDay = ppd * STAKE
        return {
          parlaysPerDay:   ppd,
          legsPerParlay:   lpp,
          minMins,
          label:           config.label,
          daysPlayed:      days,
          totalParlays:    parlays,
          totalHits:       hits,
          hitRate:         parlays > 0 ? Math.round(hits / parlays * 1000) / 10 : null,
          avgMultiplier:   parlays > 0 ? Math.round(decimal / parlays * 100) / 100 : 0,
          stakePerDay,
          totalStaked:     Math.round(staked * 100) / 100,
          totalProfit:     Math.round(profit * 100) / 100,
          roi:             staked > 0 ? Math.round(profit / staked * 1000) / 10 : null,
          profitPerDay:    days > 0 ? Math.round(profit / days * 100) / 100 : 0,
        }
      })
    )
  ).sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999))

  // ── 10. Source comparison: run structure sweep on real, synthetic, combined ──
  // Always computed regardless of ?source= so you can compare all three in one call.
  function runStructureSweepOnDates(dates: string[]) {
    return PARLAY_COUNTS.flatMap((ppd) =>
      LEG_SIZES.flatMap((lpp) =>
        STRUCT_MINS.map((minMins) => {
          const config: Config = {
            id: `struct_${ppd}p_${lpp}l_${minMins}m`,
            label: `${ppd}×${lpp}-leg · ${minMins}+ mins`,
            parlaysPerDay: ppd, legsPerParlay: lpp,
            markets: 'pts_reb_3pm', tiers: ['LOCK', 'PLAY'],
          }
          let days = 0, parlays = 0, hits = 0, staked = 0, profit = 0, decimal = 0
          for (const date of dates) {
            const built = buildParlays(byDate.get(date) ?? [], config, minMins)
            if (built.length < ppd) continue
            days++
            for (const legs of built) {
              parlays++; staked += STAKE
              const dec = legs.map((l) => toDecimal(l.odds)).reduce((a, d) => a * d, 1)
              decimal += dec
              const hit = legs.every((l) => l.hit === true)
              const p   = hit ? STAKE * dec - STAKE : -STAKE
              if (hit) hits++
              profit += p
            }
          }
          return {
            parlaysPerDay: ppd,
            legsPerParlay: lpp,
            minMins,
            label:           config.label,
            daysPlayed:      days,
            totalParlays:    parlays,
            totalHits:       hits,
            hitRate:         parlays > 0 ? Math.round(hits / parlays * 1000) / 10 : null,
            avgMultiplier:   parlays > 0 ? Math.round(decimal / parlays * 100) / 100 : 0,
            stakePerDay:     ppd * STAKE,
            totalStaked:     Math.round(staked * 100) / 100,
            totalProfit:     Math.round(profit * 100) / 100,
            roi:             staked > 0 ? Math.round(profit / staked * 1000) / 10 : null,
            profitPerDay:    days > 0 ? Math.round(profit / days * 100) / 100 : 0,
          }
        })
      )
    ).sort((a, b) => (b.roi ?? -999) - (a.roi ?? -999))
  }

  const sourceComparison = {
    real: {
      dateRange:      realDates.length > 0 ? `${realDates[0]} to ${realDates[realDates.length - 1]}` : '',
      totalDates:     realDates.length,
      structureSweep: runStructureSweepOnDates(realDates),
    },
    synthetic: {
      dateRange:      synthDates.length > 0 ? `${synthDates[0]} to ${synthDates[synthDates.length - 1]}` : '',
      totalDates:     synthDates.length,
      structureSweep: runStructureSweepOnDates(synthDates),
    },
    combined: {
      dateRange:      allDates.length > 0 ? `${allDates[0]} to ${allDates[allDates.length - 1]}` : '',
      totalDates:     allDates.length,
      structureSweep: runStructureSweepOnDates(allDates),
    },
  }

  return NextResponse.json({
    summary: {
      totalDates:     sortedDates.length,
      dateRange:      sortedDates.length > 0 ? `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}` : '',
      source,
      realDates:      realDates.length,
      synthDates:     synthDates.length,
      stakePerParlay: STAKE,
      configsTested:  CONFIGS.length,
    },
    best:         results[0],
    bestByPpd,
    marketSummary,
    hybridResult,
    minutesSweep,
    marketsMinutesSweep,
    structureSweep,
    sourceComparison,
    topConfigs: results.slice(0, 20).map((r) => ({
      id:                r.id,
      label:             r.label,
      parlaysPerDay:     r.parlaysPerDay,
      legsPerParlay:     r.legsPerParlay,
      markets:           r.markets,
      tiers:             r.tiers,
      daysPlayed:        r.daysPlayed,
      totalParlays:      r.totalParlays,
      totalHits:         r.totalHits,
      hitRate:           r.hitRate,
      avgOddsMultiplier: r.avgOddsMultiplier,
      totalStaked:       r.totalStaked,
      totalProfit:       r.totalProfit,
      roi:               r.roi,
      profitPerDay:      r.profitPerDay,
    })),
    detail: results[0],
  })
}
