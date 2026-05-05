// /api/backtest/sgp-feed
//
// Replays the SGP generation algorithm over the past N days using historical_prop_lines,
// re-scoring confidence with prior-only logs, then checking actual results.
//
// GET ?days=45   (default 45, max 90)
//
// For each day:
//   1. Load props from historical_prop_lines with game_date = that day
//   2. Re-score each prop using scoreProps() with logs strictly before that date
//   3. Keep only LOCK/PLAY props (score >= 66)
//   4. Compute L10/L5 hit rates from prior logs — require >= 60% both
//   5. Derive home/away teams from player_game_logs matchup field
//   6. Apply same SGP selection (≥3 legs, ≥1 from each team, avg quality ≥0.62)
//   7. Check actual results; report parlay + leg hit rates
//
// Returns aggregate summary, per-leg-count breakdown, and per-day details.

import { NextResponse }   from 'next/server'
import { supabase }       from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { TEAM_ABBR }      from '@/lib/team-abbr'
import { scoreProps, type PlayerLineBias, type OpponentStatLeak, type ScoringContext } from '@/lib/confidence'
import type { Prop, StatType } from '@/types'

export const maxDuration = 120

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAT_DB_FIELD: Record<string, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  steals:         'steals',
  blocks:         'blocks',
  three_pointers: 'fg3m',
  pra:            'pra',
}

function getStatValue(log: Record<string, unknown>, statType: string): number {
  const field = STAT_DB_FIELD[statType] ?? statType
  return Number(log[field] ?? 0)
}

const ABBR_NORM: Record<string, string> = {
  GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', NJ: 'NJN',
}
function normaliseAbbr(abbr: string): string { return ABBR_NORM[abbr] ?? abbr }

function teamFromMatchup(matchup: string, isHome: boolean): string | null {
  if (matchup.includes(' @ ')) {
    const [away, home] = matchup.split(' @ ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  if (matchup.includes(' vs. ')) {
    const [home, away] = matchup.split(' vs. ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  return null
}

function homeAwayFromMatchup(matchup: string, isHome: boolean): { homeTeam: string; awayTeam: string } | null {
  let home: string, away: string
  if (matchup.includes(' @ ')) {
    [away, home] = matchup.split(' @ ').map((s) => s.trim())
  } else if (matchup.includes(' vs. ')) {
    [home, away] = matchup.split(' vs. ').map((s) => s.trim())
  } else {
    return null
  }
  // Validate: if isHome, player's team should be home
  const playerTeam = normaliseAbbr(isHome ? home : away)
  const oppTeam    = normaliseAbbr(isHome ? away : home)
  return {
    homeTeam: isHome ? playerTeam : oppTeam,
    awayTeam: isHome ? oppTeam : playerTeam,
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PropLine {
  player_name:   string
  stat_type:     string
  direction:     string
  line:          number
  game_date:     string
  commence_time: string | null
  odds?:         number | null
}

interface GameLogRow {
  player_name: string
  game_date:   string
  matchup:     string
  is_home:     boolean
  points:      number
  rebounds:    number
  assists:     number
  pra:         number
  blocks:      number
  steals:      number
  fg3m:        number
  minutes:     number
}

interface ScoredLeg {
  player_name:      string
  team:             string
  stat_type:        string
  line:             number
  direction:        'over' | 'under'
  confidence_label: string
  confidence_score: number
  game_id:          string   // synthetic: "HOME|AWAY|date"
  home_team:        string
  away_team:        string
  l10_hits:         number
  l10_total:        number
  l5_hits:          number
  l5_total:         number
  sgp_score:        number
  hit:              boolean
}

interface SGPResult {
  gameId:     string
  homeTeam:   string
  awayTeam:   string
  legs:       ScoredLeg[]
  quality:    number
  legsHit:    number
  parlayHit:  boolean
}

interface DayResult {
  date:      string
  generated: number
  parlayHit: number
  legHits:   number
  legTotal:  number
  sgps:      SGPResult[]
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url  = new URL(req.url)
  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') ?? '45', 10)))

  // Date range: yesterday back N days (need actual results)
  const endDate = new Date()
  endDate.setDate(endDate.getDate() - 1)
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - (days - 1))

  const toDateStr = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const startStr  = toDateStr(startDate)
  const endStr    = toDateStr(endDate)

  // ── 1. Load historical prop lines in date range ───────────────────────────

  const allProps: PropLine[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name, stat_type, direction, line, game_date, commence_time, odds')
        .gte('game_date', startStr)
        .lte('game_date', endStr)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) allProps.push(row as PropLine)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  if (allProps.length === 0) {
    return NextResponse.json({
      error: 'No historical props found in date range',
      dateRange: { start: startStr, end: endStr },
    }, { status: 400 })
  }

  // ── 2. Load game logs for all relevant players ────────────────────────────

  const playerNames = [...new Set(allProps.map((p) => p.player_name))]
  const allLogs: GameLogRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, matchup, is_home, points, rebounds, assists, pra, blocks, steals, fg3m, minutes')
        .in('player_name', playerNames)
        .order('game_date', { ascending: false })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) allLogs.push(row as GameLogRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // Index logs by player (descending date)
  const logsByPlayer = new Map<string, GameLogRow[]>()
  for (const log of allLogs) {
    if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
    logsByPlayer.get(log.player_name)!.push(log)
  }

  // Index actual results: "player|date" → log
  const actualByKey = new Map<string, GameLogRow>()
  for (const log of allLogs) {
    actualByKey.set(`${log.player_name}|${log.game_date}`, log)
  }

  // ── 3. Load player bias + opponent leaks (for scoreProps) ─────────────────

  const { data: biasRows } = await supabase
    .from('player_line_bias')
    .select('player_name, stat_type, hit_rate, median_ratio, sample_count')
  const biasMap = new Map<string, PlayerLineBias>()
  for (const row of biasRows ?? []) {
    biasMap.set(`${row.player_name}|${row.stat_type}`, {
      hit_rate:     Number(row.hit_rate),
      median_ratio: Number(row.median_ratio),
      sample_count: Number(row.sample_count),
    })
  }

  const { data: leakRows } = await supabase
    .from('opponent_stat_leaks')
    .select('opponent_team, stat_type, over_hit_rate, median_ratio, sample_count')
  const leakMap = new Map<string, OpponentStatLeak>()
  for (const row of leakRows ?? []) {
    leakMap.set(`${row.opponent_team}|${row.stat_type}`, {
      over_hit_rate: Number(row.over_hit_rate),
      median_ratio:  Number(row.median_ratio),
      sample_count:  Number(row.sample_count),
    })
  }

  // ── 4. Group props by date, dedup, and replay algorithm ──────────────────

  const propsByDate = new Map<string, PropLine[]>()
  for (const p of allProps) {
    if (!propsByDate.has(p.game_date)) propsByDate.set(p.game_date, [])
    propsByDate.get(p.game_date)!.push(p)
  }

  const pickUniquePlayers = (pool: ScoredLeg[], max: number): ScoredLeg[] => {
    const seen = new Set<string>()
    const picks: ScoredLeg[] = []
    for (const l of pool) {
      if (picks.length >= max) break
      if (!seen.has(l.player_name)) { picks.push(l); seen.add(l.player_name) }
    }
    return picks
  }

  const dayResults: DayResult[] = []
  const dates = [...propsByDate.keys()].sort()

  for (const date of dates) {
    const dayProps = propsByDate.get(date)!

    // Dedup: keep one per player+stat+direction (prefer 'over' to match scoreProps convention)
    const propMap = new Map<string, PropLine>()
    for (const p of dayProps) {
      const key = `${p.player_name}|${p.stat_type}|${p.direction}`
      if (!propMap.has(key)) propMap.set(key, p)
    }
    const props = [...propMap.values()]

    const scoredLegs: ScoredLeg[] = []

    for (const prop of props) {
      if (!STAT_DB_FIELD[prop.stat_type]) continue

      const playerLogs  = logsByPlayer.get(prop.player_name) ?? []
      const priorLogs   = playerLogs.filter((g) => g.game_date < date)
      const activePrior = priorLogs.filter((g) => Number(g.minutes ?? 0) >= 5)
      if (activePrior.length < 5) continue

      // Re-score using prior logs only
      const propObj: Prop = {
        id:            `bt-${prop.player_name}-${prop.stat_type}-${date}`,
        player_id:     0,
        player_name:   prop.player_name,
        team:          '',
        opponent:      '',
        game_id:       '',
        stat_type:     prop.stat_type as StatType,
        direction:     prop.direction as 'over' | 'under',
        line:          prop.line,
        odds:          prop.odds ?? undefined,
        commence_time: prop.commence_time ?? `${date}T23:30:00+00:00`,
      }

      // Derive opponent from game log for that date
      const gameLogForDate = actualByKey.get(`${prop.player_name}|${date}`)
      let opponentAbbr: string | null = null
      if (gameLogForDate) {
        const parts = gameLogForDate.matchup.split('@')
        if (parts.length === 2) {
          opponentAbbr = gameLogForDate.is_home ? parts[0].trim() : parts[1].trim()
        }
      }

      const ctx: ScoringContext = {
        playerBias:   biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
        opponentLeak: opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
        opponentAbbr,
      }

      const scored = scoreProps(propObj, priorLogs, null, ctx)
      if (!['LOCK', 'PLAY'].includes(scored.confidence_label)) continue
      if ((scored.confidence_score ?? 0) < 66) continue

      // Compute L10/L5 from prior active logs
      const isHit = (g: GameLogRow) => {
        const val = getStatValue(g as unknown as Record<string, unknown>, prop.stat_type)
        return prop.direction === 'over' ? val > prop.line : val < prop.line
      }

      const l10     = activePrior.slice(0, 10)
      const l5      = activePrior.slice(0, 5)
      const l10Hits = l10.filter(isHit).length
      const l5Hits  = l5.filter(isHit).length
      const l10Rate = l10Hits / l10.length
      const l5Rate  = l5Hits  / l5.length

      if (l10Rate < 0.60) continue
      if (l5Rate  < 0.60) continue

      // Check actual result
      const actual = actualByKey.get(`${prop.player_name}|${date}`)
      if (!actual || Number(actual.minutes ?? 0) < 5) continue  // DNP — skip

      const actualVal = getStatValue(actual as unknown as Record<string, unknown>, prop.stat_type)
      const hit = prop.direction === 'over' ? actualVal > prop.line : actualVal < prop.line

      // Derive team + game info from actual game log
      const playerTeam = teamFromMatchup(actual.matchup, actual.is_home)
      if (!playerTeam) continue

      const gameInfo = homeAwayFromMatchup(actual.matchup, actual.is_home)
      if (!gameInfo) continue

      const gameId   = [gameInfo.homeTeam, gameInfo.awayTeam].sort().join('|') + `|${date}`
      const momentum = l5Rate >= l10Rate ? 1.0 : Math.min(1, l5Rate / l10Rate)
      const normConf = Math.min(1, Math.max(0, ((scored.confidence_score ?? 66) - 66) / 24))
      const sgpScore = l10Rate * 0.50 + normConf * 0.30 + momentum * 0.20

      scoredLegs.push({
        player_name:      prop.player_name,
        team:             playerTeam,
        stat_type:        prop.stat_type,
        line:             prop.line,
        direction:        prop.direction as 'over' | 'under',
        confidence_label: scored.confidence_label,
        confidence_score: scored.confidence_score ?? 66,
        game_id:          gameId,
        home_team:        gameInfo.homeTeam,
        away_team:        gameInfo.awayTeam,
        l10_hits:         l10Hits,
        l10_total:        l10.length,
        l5_hits:          l5Hits,
        l5_total:         l5.length,
        sgp_score:        sgpScore,
        hit,
      })
    }

    // Group by game, select best legs (same logic as generate algorithm)
    const byGame = new Map<string, ScoredLeg[]>()
    for (const leg of scoredLegs) {
      if (!byGame.has(leg.game_id)) byGame.set(leg.game_id, [])
      byGame.get(leg.game_id)!.push(leg)
    }

    const daySGPs: SGPResult[] = []

    for (const [gameId, legs] of byGame) {
      if (legs.length < 2) continue

      const sample   = legs[0]
      const homeAbbr = TEAM_ABBR[sample.home_team] ?? sample.home_team
      const awayAbbr = TEAM_ABBR[sample.away_team] ?? sample.away_team

      const sorted   = [...legs].sort((a, b) => b.sgp_score - a.sgp_score)
      const homeLegs = sorted.filter((l) => l.team === homeAbbr)
      const awayLegs = sorted.filter((l) => l.team === awayAbbr)

      if (homeLegs.length < 1 || awayLegs.length < 1) continue

      const homePicks = pickUniquePlayers(homeLegs, 2)
      const awayPicks = pickUniquePlayers(awayLegs, 2)
      const selected  = [...homePicks, ...awayPicks]
        .sort((a, b) => b.sgp_score - a.sgp_score)
        .slice(0, 4)

      if (selected.length < 3) continue

      const quality = selected.reduce((s, l) => s + l.sgp_score, 0) / selected.length
      if (quality < 0.62) continue

      const legsHit  = selected.filter((l) => l.hit).length
      const parlayHit = legsHit === selected.length

      daySGPs.push({ gameId, homeTeam: sample.home_team, awayTeam: sample.away_team, legs: selected, quality, legsHit, parlayHit })
    }

    if (daySGPs.length > 0) {
      dayResults.push({
        date,
        generated: daySGPs.length,
        parlayHit: daySGPs.filter((s) => s.parlayHit).length,
        legHits:   daySGPs.reduce((s, sgp) => s + sgp.legsHit, 0),
        legTotal:  daySGPs.reduce((s, sgp) => s + sgp.legs.length, 0),
        sgps:      daySGPs,
      })
    }
  }

  // ── 5. Aggregate ──────────────────────────────────────────────────────────

  const totalGenerated = dayResults.reduce((s, d) => s + d.generated, 0)
  const totalParlayHit = dayResults.reduce((s, d) => s + d.parlayHit, 0)
  const totalLegHits   = dayResults.reduce((s, d) => s + d.legHits, 0)
  const totalLegs      = dayResults.reduce((s, d) => s + d.legTotal, 0)

  const byLegCount: Record<number, { total: number; hit: number }> = {}
  for (const d of dayResults) {
    for (const sgp of d.sgps) {
      const n = sgp.legs.length
      if (!byLegCount[n]) byLegCount[n] = { total: 0, hit: 0 }
      byLegCount[n].total++
      if (sgp.parlayHit) byLegCount[n].hit++
    }
  }

  return NextResponse.json({
    dateRange:   { start: startStr, end: endStr },
    daysChecked: days,
    daysWithSGPs: dayResults.length,
    propsInRange: allProps.length,
    summary: {
      totalSGPs:     totalGenerated,
      parlayHits:    totalParlayHit,
      parlayHitRate: totalGenerated > 0 ? Math.round(totalParlayHit / totalGenerated * 1000) / 10 : null,
      totalLegs,
      legHits:       totalLegHits,
      legHitRate:    totalLegs > 0 ? Math.round(totalLegHits / totalLegs * 1000) / 10 : null,
    },
    byLegCount: Object.entries(byLegCount)
      .map(([n, d]) => ({
        legs:         Number(n),
        total:        d.total,
        hits:         d.hit,
        parlayHitRate: d.total > 0 ? Math.round(d.hit / d.total * 1000) / 10 : null,
      }))
      .sort((a, b) => a.legs - b.legs),
    byDay: dayResults.map((d) => ({
      date:         d.date,
      generated:    d.generated,
      parlayHit:    d.parlayHit,
      parlayHitRate: d.generated > 0 ? Math.round(d.parlayHit / d.generated * 1000) / 10 : null,
      legHits:      d.legHits,
      legTotal:     d.legTotal,
      legHitRate:   d.legTotal > 0 ? Math.round(d.legHits / d.legTotal * 1000) / 10 : null,
      sgps: d.sgps.map((sgp) => ({
        matchup:   `${TEAM_ABBR[sgp.awayTeam] ?? sgp.awayTeam} @ ${TEAM_ABBR[sgp.homeTeam] ?? sgp.homeTeam}`,
        legs:      sgp.legs.length,
        quality:   Math.round(sgp.quality * 1000) / 1000,
        legsHit:   sgp.legsHit,
        parlayHit: sgp.parlayHit,
        details:   sgp.legs.map((l) => ({
          player:    l.player_name,
          team:      l.team,
          stat:      l.stat_type,
          line:      l.line,
          dir:       l.direction,
          l10:       `${l.l10_hits}/${l.l10_total}`,
          conf:      `${Math.round(l.confidence_score)} ${l.confidence_label}`,
          hit:       l.hit,
        })),
      })),
    })),
  })
}
