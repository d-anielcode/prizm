// /api/feed/backtest — Backtest SGP selection criteria over past N days
//
// GET ?days=45
//
// Approach (since we don't store historical prop snapshots):
//   · Take all current LOCK/PLAY props (player + stat + line + direction)
//   · For each player's game log over the past N days (date D):
//       - Compute L10/L5 hit rates using ONLY games before D (no look-ahead)
//       - Check if the prop would have qualified (L10>=60%, L5>=60%, >=5 prior games)
//       - If qualified, check if the actual game on D hit the line
//   · Group qualifying legs by game_id → simulate SGP selection
//   · Report: parlay hit rate, leg hit rate, breakdown by leg count, quality tier
//
// Caveat: current lines are used as proxies for historical lines.
// Lines may have moved slightly, but this gives a solid signal on selection quality.

import { NextResponse } from 'next/server'
import { supabase }     from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { TEAM_ABBR }    from '@/lib/team-abbr'
import type { StatType } from '@/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAT_DB_FIELD: Record<StatType, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  steals:         'steals',
  blocks:         'blocks',
  three_pointers: 'fg3m',
  pra:            'pra',
}

function getStatValue(log: Record<string, unknown>, statType: string): number {
  const field = STAT_DB_FIELD[statType as StatType] ?? statType
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface LegResult {
  date:        string
  game_id:     string
  home_team:   string
  away_team:   string
  player_name: string
  team:        string
  stat_type:   string
  line:        number
  direction:   'over' | 'under'
  actual:      number
  hit:         boolean
  l10_hits:    number
  l10_total:   number
  l5_hits:     number
  l5_total:    number
  sgp_score:   number
}

interface SimParlay {
  date:     string
  game_id:  string
  home:     string
  away:     string
  legs:     LegResult[]
  quality:  number
  hit:      boolean
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url   = new URL(req.url)
  const days  = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') ?? '45')))
  const debug = url.searchParams.get('debug') === '1'

  const today     = new Date()
  const sinceDate = new Date(today)
  sinceDate.setDate(sinceDate.getDate() - days)
  const sinceDateStr = sinceDate.toISOString().split('T')[0]

  // 1. Fetch current LOCK/PLAY props
  const { data: propsRaw, error: propsErr } = await supabase
    .from('props')
    .select('player_name, team, stat_type, line, direction, odds, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
    .in('confidence_label', ['LOCK', 'PLAY'])
    .gte('confidence_score', 66)

  if (propsErr) return NextResponse.json({ error: propsErr.message }, { status: 500 })
  if (!propsRaw || propsRaw.length === 0) {
    return NextResponse.json({ error: 'No LOCK/PLAY props found', days })
  }

  // Deduplicate props — keep highest-confidence per player+stat+direction
  const propMap = new Map<string, typeof propsRaw[0]>()
  for (const p of propsRaw) {
    const key = `${p.player_name}|${p.stat_type}|${p.direction}`
    const ex  = propMap.get(key)
    if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) propMap.set(key, p)
  }
  const props = [...propMap.values()]

  // 2. Fetch ALL game logs for these players over last (days + 90) days
  //    Extra 90 days gives us enough history before the backtest window
  const playerNames = [...new Set(props.map((p) => p.player_name))]
  const logSince    = new Date(sinceDate)
  logSince.setDate(logSince.getDate() - 90)
  const logSinceStr = logSince.toISOString().split('T')[0]

  // Paginate to bypass Supabase's 1000-row PostgREST limit
  const logsRaw: Record<string, unknown>[] = []
  let page = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('player_game_logs')
      .select('player_name, game_date, matchup, is_home, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
      .in('player_name', playerNames)
      .gte('game_date', logSinceStr)
      .order('game_date', { ascending: false })
      .range(page * PAGE, (page + 1) * PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    logsRaw.push(...(data as Record<string, unknown>[]))
    if (data.length < PAGE) break
    page++
    if (page > 9) break  // safety cap at 10k rows
  }
  const logsErr = null

  if (debug) {
    const samplePlayer = playerNames[0]
    const sampleLogs   = logsRaw.filter((l) => l.player_name === samplePlayer)
    const active = sampleLogs.filter((g) => Number(g.minutes ?? 0) >= 5)
    const windowGames = active.filter(
      (g) => (g.game_date as string) >= sinceDateStr && (g.game_date as string) < today.toISOString().split('T')[0]
    )
    const sampleProp = props.find((p) => p.player_name === samplePlayer)

    // Check one window game manually
    let manualCheck = null
    if (sampleProp && windowGames.length > 0) {
      const game = windowGames[0]
      const history = active.filter((g) => (g.game_date as string) < (game.game_date as string))
      const isHit = (g: Record<string, unknown>) => {
        const val = getStatValue(g, sampleProp.stat_type)
        return sampleProp.direction === 'over' ? val > sampleProp.line : val < sampleProp.line
      }
      const l10 = history.slice(0, 10)
      const l5  = history.slice(0, 5)
      manualCheck = {
        game_date: game.game_date,
        history_count: history.length,
        l10_hits: l10.filter(isHit).length, l10_total: l10.length,
        l5_hits:  l5.filter(isHit).length,  l5_total:  l5.length,
        l10_rate: l10.length > 0 ? l10.filter(isHit).length / l10.length : null,
        l5_rate:  l5.length  > 0 ?  l5.filter(isHit).length  / l5.length  : null,
        prop: { stat: sampleProp.stat_type, line: sampleProp.line, dir: sampleProp.direction },
      }
    }

    return NextResponse.json({
      debug: true,
      prop_count:    props.length,
      player_count:  playerNames.length,
      total_logs:    logsRaw.length,
      sinceDateStr, logSinceStr,
      todayStr: today.toISOString().split('T')[0],
      sample_player:    samplePlayer,
      sample_log_count: sampleLogs.length,
      sample_active:    active.length,
      sample_window_games: windowGames.length,
      sample_window_dates: windowGames.slice(0, 5).map((l) => l.game_date),
      manual_check: manualCheck,
    })
  }

  // Index all logs by player (sorted descending — most recent first)
  const logsByPlayer = new Map<string, Record<string, unknown>[]>()
  const teamByPlayer = new Map<string, string>()

  for (const log of logsRaw ?? []) {
    const name = log.player_name as string
    if (!logsByPlayer.has(name)) logsByPlayer.set(name, [])
    logsByPlayer.get(name)!.push(log as Record<string, unknown>)

    if (!teamByPlayer.has(name) && log.matchup && log.is_home != null) {
      const abbr = teamFromMatchup(log.matchup as string, log.is_home as boolean)
      if (abbr) teamByPlayer.set(name, abbr)
    }
  }

  // 3. For each prop, simulate each qualifying past game
  //    game_date must be in [sinceDateStr, today) and have a played result
  const qualifiedLegs: LegResult[] = []

  for (const prop of props) {
    if (!prop.home_team || !prop.away_team) continue

    const allPlayerLogs = logsByPlayer.get(prop.player_name) ?? []
    // Active logs only
    const active = allPlayerLogs.filter((g) => Number(g.minutes ?? 0) >= 5)
    const team   = teamByPlayer.get(prop.player_name) ?? prop.team ?? 'TBD'

    // Find games within the backtest window
    const windowGames = active.filter(
      (g) => (g.game_date as string) >= sinceDateStr && (g.game_date as string) < today.toISOString().split('T')[0],
    )

    for (const game of windowGames) {
      const gameDate = game.game_date as string

      // History = active logs strictly before this game date
      const history = active.filter((g) => (g.game_date as string) < gameDate)
      if (history.length < 5) continue  // not enough prior data

      const isHit = (g: Record<string, unknown>) => {
        const val = getStatValue(g, prop.stat_type)
        return prop.direction === 'over' ? val > prop.line : val < prop.line
      }

      const l10     = history.slice(0, 10)
      const l5      = history.slice(0, 5)
      const l10Hits = l10.filter(isHit).length
      const l5Hits  = l5.filter(isHit).length
      const l10Rate = l10Hits / l10.length
      const l5Rate  = l5Hits  / l5.length

      if (l10Rate < 0.60) continue
      if (l5Rate  < 0.60) continue

      const momentum = l5Rate >= l10Rate ? 1.0 : Math.min(1, l5Rate / l10Rate)
      const normConf = Math.min(1, Math.max(0, ((prop.confidence_score ?? 66) - 66) / 24))
      const sgpScore = l10Rate * 0.50 + normConf * 0.30 + momentum * 0.20

      // Did the actual game hit?
      const actual = getStatValue(game, prop.stat_type)
      const hit    = prop.direction === 'over' ? actual > prop.line : actual < prop.line

      // Derive home/away from matchup — normalize game_id so home and away players
      // from the same game land in the same group (matchup format differs per team)
      const matchup  = (game.matchup as string) ?? ''
      let homeTeam   = 'UNK'
      let awayTeam   = 'UNK'
      if (matchup.includes(' @ ')) {
        const [away, home] = matchup.split(' @ ')
        homeTeam = normaliseAbbr(home.trim())
        awayTeam = normaliseAbbr(away.trim())
      } else if (matchup.includes(' vs. ')) {
        const [home, away] = matchup.split(' vs. ')
        homeTeam = normaliseAbbr(home.trim())
        awayTeam = normaliseAbbr(away.trim())
      }
      // Sort teams so both home/away perspectives produce the same key
      const gameId = `${gameDate}|${[homeTeam, awayTeam].sort().join('-')}`

      qualifiedLegs.push({
        date: gameDate, game_id: gameId,
        home_team: homeTeam, away_team: awayTeam,
        player_name: prop.player_name, team,
        stat_type: prop.stat_type, line: prop.line, direction: prop.direction as 'over' | 'under',
        actual, hit,
        l10_hits: l10Hits, l10_total: l10.length,
        l5_hits: l5Hits, l5_total: l5.length,
        sgp_score: sgpScore,
      })
    }
  }

  // 4. Group qualified legs by date+game, simulate SGP selection
  const byDateGame = new Map<string, LegResult[]>()
  for (const leg of qualifiedLegs) {
    const key = `${leg.date}|${leg.game_id}`
    if (!byDateGame.has(key)) byDateGame.set(key, [])
    byDateGame.get(key)!.push(leg)
  }

  const pickUniquePlayers = (pool: LegResult[], max: number): LegResult[] => {
    const seen = new Set<string>()
    const picks: LegResult[] = []
    for (const l of pool) {
      if (picks.length >= max) break
      if (!seen.has(l.player_name)) { picks.push(l); seen.add(l.player_name) }
    }
    return picks
  }

  const simParlays: SimParlay[] = []

  for (const [, legs] of byDateGame) {
    const sample   = legs[0]
    const homeAbbr = TEAM_ABBR[sample.home_team] ?? sample.home_team
    const awayAbbr = TEAM_ABBR[sample.away_team] ?? sample.away_team

    const sorted   = [...legs].sort((a, b) => b.sgp_score - a.sgp_score)
    const homeLegs = sorted.filter((l) => l.team === homeAbbr)
    const awayLegs = sorted.filter((l) => l.team === awayAbbr)

    if (homeLegs.length < 1 || awayLegs.length < 1) continue

    const homePicks = pickUniquePlayers(homeLegs, 3)
    const awayPicks = pickUniquePlayers(awayLegs, 3)
    const selected  = [...homePicks, ...awayPicks]
      .sort((a, b) => b.sgp_score - a.sgp_score)
      .slice(0, 5)

    if (selected.length < 3) continue

    const quality = selected.reduce((s, l) => s + l.sgp_score, 0) / selected.length
    if (quality < 0.62) continue

    const allHit = selected.every((l) => l.hit)

    simParlays.push({
      date:    sample.date,
      game_id: sample.game_id,
      home:    sample.home_team,
      away:    sample.away_team,
      legs:    selected,
      quality,
      hit:     allHit,
    })
  }

  simParlays.sort((a, b) => a.date.localeCompare(b.date))

  // 5. Aggregate
  const hits    = simParlays.filter((p) => p.hit)
  const allLegs = simParlays.flatMap((p) => p.legs)
  const legHits = allLegs.filter((l) => l.hit)

  const byLegCount: Record<number, { total: number; hits: number; hit_rate: number | null }> = {}
  for (const p of simParlays) {
    const n = p.legs.length
    if (!byLegCount[n]) byLegCount[n] = { total: 0, hits: 0, hit_rate: null }
    byLegCount[n].total++
    if (p.hit) byLegCount[n].hits++
  }
  for (const n of Object.keys(byLegCount)) {
    const b = byLegCount[Number(n)]
    b.hit_rate = b.total > 0 ? Math.round(b.hits / b.total * 1000) / 10 : null
  }

  const highQ     = simParlays.filter((p) => p.quality >= 0.70)
  const highQHits = highQ.filter((p) => p.hit)

  // Per-stat breakdown
  const byStat: Record<string, { total: number; hits: number }> = {}
  for (const leg of allLegs) {
    if (!byStat[leg.stat_type]) byStat[leg.stat_type] = { total: 0, hits: 0 }
    byStat[leg.stat_type].total++
    if (leg.hit) byStat[leg.stat_type].hits++
  }
  const byStatRates = Object.fromEntries(
    Object.entries(byStat).map(([k, v]) => [k, {
      total: v.total, hits: v.hits,
      hit_rate: Math.round(v.hits / v.total * 1000) / 10,
    }])
  )

  return NextResponse.json({
    days,
    note: 'Uses current prop lines against historical game results — lines may have shifted slightly',
    summary: {
      total_parlays:    simParlays.length,
      parlay_hits:      hits.length,
      parlay_hit_rate:  simParlays.length > 0 ? Math.round(hits.length / simParlays.length * 1000) / 10 : null,
      total_legs:       allLegs.length,
      leg_hits:         legHits.length,
      leg_hit_rate:     allLegs.length > 0 ? Math.round(legHits.length / allLegs.length * 1000) / 10 : null,
    },
    by_leg_count: byLegCount,
    high_quality: {
      count:    highQ.length,
      hits:     highQHits.length,
      hit_rate: highQ.length > 0 ? Math.round(highQHits.length / highQ.length * 1000) / 10 : null,
      note:     'quality >= 0.70',
    },
    by_stat: byStatRates,
    parlays: simParlays.map((p) => ({
      date: p.date, away: p.away, home: p.home,
      legs: p.legs.length, quality: Math.round(p.quality * 1000) / 1000,
      hit: p.hit,
      legs_detail: p.legs.map((l) => ({
        player: l.player_name, stat: l.stat_type,
        line: `${l.direction === 'over' ? 'O' : 'U'}${l.line}`,
        actual: l.actual, hit: l.hit,
        l10: `${l.l10_hits}/${l.l10_total}`,
      })),
    })),
  })
}
