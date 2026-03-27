// /api/enrich — Enriches all cached props with AI confidence scores
// Uses real NBA game logs from player_game_logs + team_defense_stats tables.
// Run scripts/fetch_nba_stats.py first to populate those tables.
// Falls back to book-odds scoring if game log data isn't available.
//
// New in v3: fetches spreads (ESPN scoreboard) and injury reports (ESPN API)
// for blowout risk and news/injury factors. Both are best-effort — if ESPN
// is unreachable, those factors simply default to 0.50 (neutral).

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { TEAM_ABBR } from '@/lib/team-abbr'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

export const maxDuration = 300
import {
  scoreProps,
  type GameLog,
  type HistoricalLine,
  type TeamDefenseStats,
  type ScoringContext,
  type InjuredTeammate,
  type SeasonStats,
  type PlayerLineBias,
  type OpponentStatLeak,
} from '@/lib/confidence'
import type { Prop, StatType, Direction, ConfidenceLabel } from '@/types'

// ── ESPN free APIs ─────────────────────────────────────────────────────────────
// Both are undocumented but widely stable — wrapped in try/catch so failures
// just return empty maps and the model falls back to neutral factor values.

interface EspnInjury {
  playerName: string
  teamAbbr:   string
  status:     'active' | 'questionable' | 'doubtful' | 'out'
}

/** Fetch today's NBA injury report from ESPN. */
async function fetchEspnInjuries(): Promise<Map<string, EspnInjury>> {
  const map = new Map<string, EspnInjury>()
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      { next: { revalidate: 3600 } }
    )
    if (!res.ok) return map

    const data = await res.json() as {
      injuries?: Array<{
        athlete?: { displayName?: string; team?: { abbreviation?: string } }
        type?:    { description?: string }
        status?:  string
      }>
    }

    for (const item of data.injuries ?? []) {
      const name   = item.athlete?.displayName?.trim()
      const team   = item.athlete?.team?.abbreviation?.trim().toUpperCase()
      const rawStatus = (item.type?.description ?? item.status ?? '').toLowerCase()
      if (!name || !team) continue

      let status: EspnInjury['status'] = 'active'
      if (rawStatus.includes('out'))          status = 'out'
      else if (rawStatus.includes('doubtful')) status = 'doubtful'
      else if (rawStatus.includes('question')) status = 'questionable'
      else continue  // probable / day-to-day → treat as active, skip

      map.set(name, { playerName: name, teamAbbr: team, status })
    }
  } catch {
    // ESPN unreachable — return empty map, all players treated as active
  }
  return map
}

interface GameOdds { spread: number; total: number | null }

/** Fetch today's game spreads + O/U totals from ESPN scoreboard. */
async function fetchEspnSpreads(): Promise<Map<string, GameOdds>> {
  const map = new Map<string, GameOdds>()
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
      { next: { revalidate: 3600 } }
    )
    if (!res.ok) return map

    const data = await res.json() as {
      events?: Array<{
        competitions?: Array<{
          competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>
          odds?: Array<{ details?: string; overUnder?: number }>
        }>
      }>
    }

    for (const event of data.events ?? []) {
      for (const comp of event.competitions ?? []) {
        const home = comp.competitors?.find((c) => c.homeAway === 'home')?.team?.abbreviation
        const away = comp.competitors?.find((c) => c.homeAway === 'away')?.team?.abbreviation
        if (!home || !away) continue

        const oddsEntry = comp.odds?.[0]
        const details   = oddsEntry?.details ?? ''
        const match     = details.match(/-?\d+(\.\d+)?/)
        if (!match) continue

        const spread = Math.abs(parseFloat(match[0]))
        if (isNaN(spread)) continue

        const total = oddsEntry?.overUnder != null ? Number(oddsEntry.overUnder) : null
        const entry: GameOdds = { spread, total }
        map.set(`${home}|${away}`, entry)
        map.set(`${away}|${home}`, entry)
      }
    }
  } catch {
    // ESPN unreachable — return empty map
  }
  return map
}

// ── Team name → abbreviation lookup ──────────────────────────────────────────

// ── Derive opponent abbreviation + home/away + player team from prop + logs ───
function deriveMatchupContext(
  prop: Prop,
  logs: GameLog[],
): { isHome: boolean | null; opponentAbbr: string | null; playerTeamAbbr: string | null } {
  if (logs.length === 0) return { isHome: null, opponentAbbr: null, playerTeamAbbr: null }

  const latestMatchup = logs[0]?.matchup ?? ''
  const matchParts = latestMatchup.split(/\s+vs\.\s+|\s+@\s+/)
  const playerTeamAbbr = matchParts[0]?.trim().toUpperCase() ?? null
  if (!playerTeamAbbr) return { isHome: null, opponentAbbr: null, playerTeamAbbr: null }

  const homeAbbr = prop.home_team ? (TEAM_ABBR[prop.home_team] ?? null) : null
  const awayAbbr = prop.away_team ? (TEAM_ABBR[prop.away_team] ?? null) : null

  if (homeAbbr && playerTeamAbbr === homeAbbr) {
    return { isHome: true,  opponentAbbr: awayAbbr,  playerTeamAbbr }
  }
  if (awayAbbr && playerTeamAbbr === awayAbbr) {
    return { isHome: false, opponentAbbr: homeAbbr, playerTeamAbbr }
  }

  return { isHome: null, opponentAbbr: null, playerTeamAbbr }
}

// ── Main enrichment logic ─────────────────────────────────────────────────────
async function runEnrichment(force = false) {
  const keyUsed = process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'
  console.log('[/api/enrich] key:', keyUsed, force ? '(force)' : '')

  // Snapshot current scores before wiping — used for trend arrows
  const prevScoreMap = new Map<string, number>()
  if (force) {
    const snap: { id: string; confidence_score: number }[] = []
    let snapFrom = 0
    while (true) {
      const { data: page } = await supabase
        .from('props')
        .select('id, confidence_score')
        .not('confidence_score', 'is', null)
        .range(snapFrom, snapFrom + 999)
      if (!page || page.length === 0) break
      for (const row of page) prevScoreMap.set(row.id, Number(row.confidence_score))
      snap.push(...page)
      if (page.length < 1000) break
      snapFrom += 1000
    }

    await supabase.from('props').update({
      confidence_score: null,
      confidence_label: null,
      risk_tier: null,
      confidence_reason: null,
    }).not('id', 'is', null)
    await supabase.from('prop_alts').update({
      confidence_score: null,
      confidence_label: null,
    }).not('id', 'is', null)
  }

  // Load ALL unscored props via pagination
  const props: Prop[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: page, error: pageError } = await supabase
      .from('props')
      .select('*')
      .is('confidence_score', null)
      .range(from, from + PAGE - 1)
    if (pageError) throw new Error(`Supabase read error: ${pageError.message}`)
    if (!page || page.length === 0) break
    props.push(...(page as Prop[]))
    if (page.length < PAGE) break
    from += PAGE
  }
  if (!props || props.length === 0) {
    return { message: 'No props to enrich', enriched: 0, total: 0 }
  }

  // ── Pre-compute keys needed for parallel fetches ─────────────────────────
  const uniqueNames = [...new Set(props.map((p) => p.player_name))]
  const gameDates   = [...new Set(
    props.map((p) => p.commence_time
      ? new Date(p.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      : null
    ).filter((d): d is string => d !== null)
  )]

  function toImpliedProb(odds: number | null | undefined): number | null {
    if (odds == null) return null
    if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100)
    if (odds > 0) return 100 / (odds + 100)
    return 0.5
  }

  // ── Fetch ALL data in parallel (ESPN + all Supabase tables) ───────────────
  // Previously sequential — now runs everything concurrently to fit Hobby 60s limit.
  console.log(`[/api/enrich] Fetching all data in parallel for ${uniqueNames.length} players...`)

  async function loadPagedGameLogs(): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    let from = 0
    const PAGE = 1000  // Supabase caps at 1000 rows/response; PAGE=2000 caused early exit
    while (true) {
      const { data: page, error } = await supabase
        .from('player_game_logs').select('*')
        .in('player_name', uniqueNames)
        .order('game_date', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) { console.error('[/api/enrich] game log error:', error.message); break }
      if (!page || page.length === 0) break
      rows.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }
    return rows
  }

  async function loadPagedHistLines(): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    let from = 0
    const PAGE = 1000  // Supabase caps at 1000 rows/response; PAGE=2000 caused early exit
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name, stat_type, direction, line, game_date')
        .in('player_name', uniqueNames)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      rows.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }
    return rows
  }

  async function loadMorningOdds(): Promise<Map<string, number | null>> {
    const map = new Map<string, number | null>()
    if (gameDates.length === 0) return map
    const { data: rows } = await supabase
      .from('prop_history')
      .select('player_name, stat_type, direction, odds, game_date')
      .in('game_date', gameDates)
    for (const row of rows ?? []) {
      const key = `${row.player_name}|${row.stat_type}|${row.direction}|${row.game_date}`
      if (!map.has(key)) map.set(key, toImpliedProb(row.odds as number | null))
    }
    return map
  }

  const [
    allLogRows,
    histRows,
    { data: defRows },
    { data: seasonRows },
    { data: biasRows },
    { data: leakRows },
    openingOddsMap,
    spreadMap,
    injuryMap,
  ] = await Promise.all([
    loadPagedGameLogs(),
    loadPagedHistLines(),
    supabase.from('team_defense_stats').select('*'),
    supabase.from('player_season_stats').select('*'),
    supabase.from('player_line_bias').select('player_name, stat_type, hit_rate, median_ratio, sample_count'),
    supabase.from('opponent_stat_leaks').select('opponent_team, stat_type, over_hit_rate, median_ratio, sample_count'),
    loadMorningOdds(),
    fetchEspnSpreads(),
    fetchEspnInjuries(),
  ])

  // ── Build in-memory maps from raw rows ────────────────────────────────────
  const logsMap = new Map<string, GameLog[]>()
  for (const row of allLogRows) {
    const name = row.player_name as string
    if (!logsMap.has(name)) logsMap.set(name, [])
    logsMap.get(name)!.push({
      game_date:  row.game_date as string,
      matchup:    row.matchup as string,
      is_home:    (row.is_home ?? false) as boolean,
      points:     Number(row.points ?? 0),
      rebounds:   Number(row.rebounds ?? 0),
      assists:    Number(row.assists ?? 0),
      steals:     Number(row.steals ?? 0),
      blocks:     Number(row.blocks ?? 0),
      fg3m:       Number(row.fg3m ?? 0),
      minutes:    Number(row.minutes ?? 0),
      pra:        Number(row.pra ?? 0),
    })
  }

  const histMap = new Map<string, HistoricalLine[]>()
  for (const row of histRows) {
    const name = row.player_name as string
    if (!histMap.has(name)) histMap.set(name, [])
    histMap.get(name)!.push({
      game_date:  row.game_date  as string,
      stat_type:  row.stat_type  as string,
      direction:  row.direction  as 'over' | 'under',
      line:       Number(row.line),
    })
  }

  const defMap = new Map<string, TeamDefenseStats>()
  for (const row of defRows ?? []) defMap.set(row.team_abbreviation as string, row as TeamDefenseStats)

  const seasonMap = new Map<string, SeasonStats>()
  for (const row of seasonRows ?? []) {
    seasonMap.set(row.player_name as string, {
      avg_points:   row.avg_points   != null ? Number(row.avg_points)   : null,
      avg_rebounds: row.avg_rebounds != null ? Number(row.avg_rebounds) : null,
      avg_assists:  row.avg_assists  != null ? Number(row.avg_assists)  : null,
      avg_steals:   row.avg_steals   != null ? Number(row.avg_steals)   : null,
      avg_blocks:   row.avg_blocks   != null ? Number(row.avg_blocks)   : null,
      avg_fg3m:     row.avg_fg3m     != null ? Number(row.avg_fg3m)     : null,
      avg_pra:      row.avg_pra      != null ? Number(row.avg_pra)      : null,
      avg_minutes:  row.avg_minutes  != null ? Number(row.avg_minutes)  : null,
      games_played: row.games_played != null ? Number(row.games_played) : null,
    })
  }

  const biasMap = new Map<string, PlayerLineBias>()
  for (const row of biasRows ?? []) {
    biasMap.set(`${row.player_name}|${row.stat_type}`, {
      hit_rate:     Number(row.hit_rate),
      median_ratio: Number(row.median_ratio),
      sample_count: Number(row.sample_count),
    })
  }

  const leakMap = new Map<string, OpponentStatLeak>()
  for (const row of leakRows ?? []) {
    leakMap.set(`${row.opponent_team}|${row.stat_type}`, {
      over_hit_rate: Number(row.over_hit_rate),
      median_ratio:  Number(row.median_ratio),
      sample_count:  Number(row.sample_count),
    })
  }

  const playersWithLogs = [...logsMap.values()].filter((l) => l.length >= 3).length
  const totalsLoaded    = [...spreadMap.values()].filter((g) => g.total != null).length / 2
  console.log(`[/api/enrich] Parallel load done — logs: ${allLogRows.length} rows (${playersWithLogs}/${uniqueNames.length} players), hist: ${histRows.length} rows, ESPN: ${spreadMap.size / 2} games (${totalsLoaded} with O/U), injuries: ${injuryMap.size}, morning odds: ${openingOddsMap.size}`)

  // Flag players with no game logs so they show up in Vercel logs for easy backfill
  const missingLogPlayers = uniqueNames.filter((name) => (logsMap.get(name)?.length ?? 0) < 3)
  if (missingLogPlayers.length > 0) {
    console.warn(`[/api/enrich] ⚠ Players with no/insufficient game logs (${missingLogPlayers.length}): ${missingLogPlayers.join(', ')}`)
    console.warn(`[/api/enrich] ⚠ Fix with: /api/gamelogs/player?name=<player+name> for each`)
  }

  // ── Build a map of team → prop players (for injured teammate detection) ────
  // We identify prop players on each team so we can flag injured teammates who
  // are relevant enough to have their own props set (= meaningful usage).
  const teamToPropPlayers = new Map<string, string[]>()  // teamAbbr → player names
  for (const prop of props) {
    const logs = logsMap.get(prop.player_name) ?? []
    const { playerTeamAbbr } = deriveMatchupContext(prop, logs)
    if (!playerTeamAbbr) continue
    if (!teamToPropPlayers.has(playerTeamAbbr)) teamToPropPlayers.set(playerTeamAbbr, [])
    const team = teamToPropPlayers.get(playerTeamAbbr)!
    if (!team.includes(prop.player_name)) team.push(prop.player_name)
  }

  // ── Score every prop ──────────────────────────────────────────────────────
  const updates = props.map((prop) => {
    const logs = logsMap.get(prop.player_name) ?? []
    const { isHome, opponentAbbr, playerTeamAbbr } = deriveMatchupContext(prop, logs)
    const defStats = opponentAbbr ? (defMap.get(opponentAbbr) ?? null) : null

    // Spread + game total: match by home|away team abbreviation pair
    const homeAbbr  = prop.home_team ? (TEAM_ABBR[prop.home_team] ?? null) : null
    const awayAbbr  = prop.away_team ? (TEAM_ABBR[prop.away_team] ?? null) : null
    const spreadKey = homeAbbr && awayAbbr ? `${homeAbbr}|${awayAbbr}` : null
    const gameOdds  = spreadKey ? (spreadMap.get(spreadKey) ?? null) : null
    const spread    = gameOdds?.spread ?? null
    const gameTotal = gameOdds?.total  ?? null

    // Player's own injury status
    const injuryEntry = injuryMap.get(prop.player_name)
    const playerStatus = injuryEntry?.status ?? 'active'

    // Injured teammates: other prop-listed players on same team who are in injury report
    const injuredTeammates: InjuredTeammate[] = []
    if (playerTeamAbbr) {
      const teammates = (teamToPropPlayers.get(playerTeamAbbr) ?? [])
        .filter((name) => name !== prop.player_name)

      for (const tName of teammates) {
        const tInjury = injuryMap.get(tName)
        if (!tInjury || tInjury.status === 'active') continue
        // Impact = 1 / (total prop players on team) — spreads the "vacated usage" equally
        const teamSize = Math.max(teammates.length + 1, 1)
        injuredTeammates.push({
          name:        tName,
          status:      tInjury.status,
          impactScore: 1 / teamSize,
        })
      }
    }

    const lineMovementDelta = (prop.opening_line != null && prop.line != null)
      ? prop.line - prop.opening_line
      : null

    // Odds movement: compare current implied prob to morning snapshot
    const gameDate = prop.commence_time
      ? new Date(prop.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      : null
    const openingKey = `${prop.player_name}|${prop.stat_type}|${prop.direction}|${gameDate}`
    const openingProb = gameDate ? openingOddsMap.get(openingKey) ?? null : null
    const currentProb = toImpliedProb((prop as unknown as Record<string, unknown>).odds as number | null)
    const oddsMovementDelta = (openingProb != null && currentProb != null)
      ? currentProb - openingProb
      : null

    const ctx: ScoringContext = {
      defStats,
      isHome,
      opponentAbbr,
      spread,
      gameTotal,
      playerStatus,
      injuredTeammates,
      seasonStats:      seasonMap.get(prop.player_name) ?? null,
      historicalLines:  histMap.get(prop.player_name)  ?? [],
      playerBias:       biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
      opponentLeak:     opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
      lineMovementDelta,
      oddsMovementDelta,
    }

    return scoreProps(prop, logs, null, ctx)
  })

  // ── Batch-upsert main props to Supabase ──────────────────────────────────
  let enriched = 0
  const BATCH = 200
  // Inject prev_confidence_score from snapshot taken before the force-wipe
  const updatesWithPrev = updates.map((u) => ({
    ...u,
    prev_confidence_score: (u.id && prevScoreMap.has(u.id)) ? prevScoreMap.get(u.id) : (u as unknown as Record<string, unknown>).prev_confidence_score ?? null,
  }))
  for (let i = 0; i < updatesWithPrev.length; i += BATCH) {
    const batch = updatesWithPrev.slice(i, i + BATCH)
    const { error: upsertError } = await supabase
      .from('props')
      .upsert(batch, { onConflict: 'id' })
    if (!upsertError) enriched += batch.length
    else console.error('[/api/enrich] Upsert error:', upsertError.message)
  }

  // ── Score alt lines from prop_alts ────────────────────────────────────────
  const altRows: Record<string, unknown>[] = []
  let altFrom = 0
  while (true) {
    const { data: page } = await supabase
      .from('prop_alts')
      .select('*')
      .is('confidence_score', null)
      .range(altFrom, altFrom + PAGE - 1)
    if (!page || page.length === 0) break
    altRows.push(...page)
    if (page.length < PAGE) break
    altFrom += PAGE
  }

  // Build main line lookup so easier alt lines get a score boost.
  // Without this, the trend factor gets dampened for very easy lines (high baseline
  // hit rate → less room to show momentum), causing "safer" alts to score lower
  // than the main line. We add +2 pts per step easier to correct for this.
  const mainLineMap = new Map<string, number>()
  for (const p of props) {
    mainLineMap.set(`${p.player_name}|${p.stat_type}|${p.direction}`, p.line)
  }
  const ALT_STEP: Record<string, number> = {
    points: 2, pra: 2, rebounds: 1, assists: 1, steals: 1, blocks: 1, three_pointers: 1,
  }
  const ALT_LOCK_T: Partial<Record<string, number>> = {
    assists: 74, pra: 78, steals: 72, blocks: 72, three_pointers: 72,
  }
  const ALT_PLAY_T: Partial<Record<string, number>> = { assists: 70, pra: 68 }
  function adjAltLabel(score: number, statType: string): ConfidenceLabel {
    if (score >= (ALT_LOCK_T[statType] ?? 68)) return 'LOCK'
    if (score >= (ALT_PLAY_T[statType] ?? 60)) return 'PLAY'
    if (score >= 50) return 'LEAN'
    return 'FADE'
  }

  let enrichedAlts = 0
  if (altRows.length > 0) {
    const altUpdates = altRows.map((alt) => {
      const pseudoProp: Prop = {
        player_id:      0,
        player_name:    alt.player_name as string,
        team:           'TBD',
        opponent:       'TBD',
        game_id:        alt.game_id as string,
        stat_type:      alt.stat_type as StatType,
        line:           alt.line as number,
        direction:      alt.direction as Direction,
        odds:           alt.odds as number | undefined,
        home_team:      alt.home_team as string | undefined,
        away_team:      alt.away_team as string | undefined,
        commence_time:  alt.commence_time as string | undefined,
      }
      const logs = logsMap.get(pseudoProp.player_name) ?? []
      const { isHome, opponentAbbr, playerTeamAbbr } = deriveMatchupContext(pseudoProp, logs)
      const defStats = opponentAbbr ? (defMap.get(opponentAbbr) ?? null) : null
      const homeAbbr = pseudoProp.home_team ? (TEAM_ABBR[pseudoProp.home_team] ?? null) : null
      const awayAbbr = pseudoProp.away_team ? (TEAM_ABBR[pseudoProp.away_team] ?? null) : null
      const spreadKey     = homeAbbr && awayAbbr ? `${homeAbbr}|${awayAbbr}` : null
      const altGameOdds   = spreadKey ? (spreadMap.get(spreadKey) ?? null) : null
      const spread        = altGameOdds?.spread ?? null
      const gameTotal     = altGameOdds?.total  ?? null
      const playerStatus  = injuryMap.get(pseudoProp.player_name)?.status ?? 'active'
      const injuredTeammates: InjuredTeammate[] = []
      if (playerTeamAbbr) {
        const teammates = (teamToPropPlayers.get(playerTeamAbbr) ?? []).filter((n) => n !== pseudoProp.player_name)
        for (const tName of teammates) {
          const tInjury = injuryMap.get(tName)
          if (!tInjury || tInjury.status === 'active') continue
          injuredTeammates.push({ name: tName, status: tInjury.status, impactScore: 1 / Math.max(teammates.length + 1, 1) })
        }
      }
      const ctx: ScoringContext = {
        defStats, isHome, opponentAbbr, spread, gameTotal, playerStatus, injuredTeammates,
        seasonStats:  seasonMap.get(pseudoProp.player_name) ?? null,
        playerBias:   biasMap.get(`${pseudoProp.player_name}|${pseudoProp.stat_type}`) ?? null,
        opponentLeak: opponentAbbr ? (leakMap.get(`${opponentAbbr}|${pseudoProp.stat_type}`) ?? null) : null,
      }
      const scored = scoreProps(pseudoProp, logs, null, ctx)

      // Line-easiness adjustment: for alt lines easier than the main line,
      // add +2 pts per step so "safer" alts always score >= the main line score.
      const mainKey = `${pseudoProp.player_name}|${pseudoProp.stat_type}|${pseudoProp.direction}`
      const mainLine = mainLineMap.get(mainKey)
      let adjScore = scored.confidence_score
      if (mainLine != null) {
        const step = ALT_STEP[pseudoProp.stat_type] ?? 1
        const rawShift = pseudoProp.direction === 'over'
          ? mainLine - pseudoProp.line   // positive = alt is lower = easier for OVER
          : pseudoProp.line - mainLine   // positive = alt is higher = easier for UNDER
        const stepsEasier = rawShift / step
        if (stepsEasier > 0) {
          adjScore = Math.min(scored.confidence_score + stepsEasier * 2, 99)
        }
      }

      return { ...alt, confidence_score: adjScore, confidence_label: adjAltLabel(adjScore, pseudoProp.stat_type) }
    })

    for (let i = 0; i < altUpdates.length; i += BATCH) {
      const batch = altUpdates.slice(i, i + BATCH)
      const { error } = await supabase.from('prop_alts').upsert(batch, { onConflict: 'id' })
      if (!error) enrichedAlts += batch.length
      else console.error('[/api/enrich] prop_alts upsert error:', error.message)
    }
  }

  // ── Auto-snapshot enriched props to prop_history ─────────────────────────
  // Runs after every enrichment so prop_history always has today's scored props.
  // Upsert on (id, game_date) is idempotent — safe to call multiple times per day.
  const fallbackDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const historyRows = (updates as unknown as Record<string, unknown>[])
    .filter((u) => u.confidence_label != null)
    .map((u) => {
      const gameDate = u.commence_time
        ? new Date(u.commence_time as string).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
        : fallbackDate
      return {
        id:                u.id,
        player_name:       u.player_name,
        stat_type:         u.stat_type,
        direction:         u.direction,
        line:              u.line,
        odds:              u.odds ?? null,
        confidence_score:  u.confidence_score,
        confidence_label:  u.confidence_label,
        risk_tier:         u.risk_tier,
        confidence_reason: u.confidence_reason,
        commence_time:     u.commence_time ?? null,
        home_team:         u.home_team ?? null,
        away_team:         u.away_team ?? null,
        game_id:           u.game_id ?? '',
        cached_at:         new Date().toISOString(),
        game_date:         gameDate,
      }
    })

  let snapshotted = 0
  for (let i = 0; i < historyRows.length; i += BATCH) {
    const { error } = await supabase
      .from('prop_history')
      .upsert(historyRows.slice(i, i + BATCH), { onConflict: 'id,game_date' })
    if (!error) snapshotted += historyRows.slice(i, i + BATCH).length
    else console.error('[/api/enrich] prop_history upsert error:', error.message)
  }
  console.log(`[/api/enrich] Snapshotted ${snapshotted} props to prop_history for ${fallbackDate}`)

  // Auto-generate curated parlay for the game date (idempotent — skips if one already exists)
  // Derive game date from enriched props so tomorrow's props generate correctly
  const parlayGameDate = (historyRows[0]?.game_date as string | undefined) ?? fallbackDate
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    fetch(`${baseUrl}/api/feed/generate/parlay?date=${parlayGameDate}`, { method: 'POST' }).catch(() => {})
  } catch { /* fire-and-forget */ }

  const injuredCount = [...injuryMap.values()].filter((i) => i.status !== 'active').length

  return {
    message: `Enriched ${enriched} props + ${enrichedAlts} alt lines`,
    enriched,
    enrichedAlts,
    snapshotted,
    total: props.length,
    playersWithGameLogs: playersWithLogs,
    teamsWithDefenseData: defMap.size,
    espnSpreadsLoaded: spreadMap.size / 2,
    espnInjuriesLoaded: injuredCount,
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('[/api/enrich] Error', { err: message })
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('[/api/enrich] Error', { err: message })
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}
