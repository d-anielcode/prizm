// /api/enrich — Enriches all cached props with AI confidence scores
// Uses real NBA game logs from player_game_logs + team_defense_stats tables.
// Run scripts/fetch_nba_stats.py first to populate those tables.
// Falls back to book-odds scoring if game log data isn't available.
//
// New in v3: fetches spreads (ESPN scoreboard) and injury reports (ESPN API)
// for blowout risk and news/injury factors. Both are best-effort — if ESPN
// is unreachable, those factors simply default to 0.50 (neutral).

import { NextResponse } from 'next/server'
import { supabase, safeQuery } from '@/lib/supabase'
import { TEAM_ABBR } from '@/lib/team-abbr'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'
import { isPlayerName } from '@/lib/odds-api'
import { normalizePlayerName } from '@/lib/lineups'

export const maxDuration = 300
import {
  scoreProps,
  getLabel,
  inferPlayerPosition,
  type GameLog,
  type HistoricalLine,
  type TeamDefenseStats,
  type DvpStats,
  type ScoringContext,
  type InjuredTeammate,
  type SeasonStats,
  type PlayerLineBias,
  type OpponentStatLeak,
  type SimThreePm,
} from '@/lib/confidence'
import type { Prop, StatType, Direction } from '@/types'

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

/** Fetch yesterday's NBA scoreboard to detect teams on back-to-back. */
async function fetchYesterdayTeams(): Promise<Set<string>> {
  const teams = new Set<string>()
  try {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const dateStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '')
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`,
      { next: { revalidate: 3600 } }
    )
    if (!res.ok) return teams
    const data = await res.json() as {
      events?: Array<{
        competitions?: Array<{
          competitors?: Array<{ team?: { abbreviation?: string } }>
        }>
      }>
    }
    for (const event of data.events ?? []) {
      for (const comp of event.competitions ?? []) {
        for (const competitor of comp.competitors ?? []) {
          const abbr = competitor.team?.abbreviation?.trim().toUpperCase()
          if (abbr) teams.add(abbr)
        }
      }
    }
  } catch {
    // ESPN unreachable — no B2B data, return empty
  }
  return teams
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

// ── Enrichment mutex ─────────────────────────────────────────────────────────
// Prevents concurrent enrichment runs via a Supabase row lock.
// Lock expires after 5 minutes (self-healing if process crashes).
const LOCK_TTL_MS = 5 * 60 * 1000

async function acquireEnrichLock(): Promise<boolean> {
  const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString()
  // Atomically claim the lock: only succeeds if currently unlocked or expired
  const { data, error } = await supabase
    .from('system_locks')
    .update({ locked_at: new Date().toISOString(), locked_by: 'enrich-route' })
    .eq('lock_name', 'enrich')
    .or(`locked_at.is.null,locked_at.lt.${cutoff}`)
    .select('lock_name')
  if (error) {
    // Table might not exist yet — proceed without lock (graceful degradation)
    logger.warn('[/api/enrich] lock table query failed, proceeding without lock', { error: error.message })
    return true
  }
  return (data?.length ?? 0) > 0
}

async function releaseEnrichLock(): Promise<void> {
  await supabase
    .from('system_locks')
    .update({ locked_at: null, locked_by: null })
    .eq('lock_name', 'enrich')
}

// ── Main enrichment logic ─────────────────────────────────────────────────────
async function runEnrichment(force = false) {
  const keyUsed = process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'
  console.log('[/api/enrich] key:', keyUsed, force ? '(force)' : '')

  // Acquire mutex — bail if another enrichment is already running
  const gotLock = await acquireEnrichLock()
  if (!gotLock) {
    logger.warn('[/api/enrich] skipped — another enrichment is already running')
    return { message: 'Enrichment already in progress', skipped: true }
  }

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

  // Drop team-total markets that pre-date the lib/odds-api.ts:isPlayerName
  // guard. Without this, enrich would score "Both Teams (Points)" as if it
  // were an individual player — fake +EV pollution on /edge, garbage rows
  // in prop_history for the bias / calibration training corpora.
  const beforeFilter = props.length
  const filteredOut: Prop[] = []
  for (let i = props.length - 1; i >= 0; i--) {
    const p = props[i]
    if (!isPlayerName(p.player_name, p.home_team, p.away_team)) {
      filteredOut.push(p)
      props.splice(i, 1)
    }
  }
  if (filteredOut.length > 0) {
    logger.warn(`[enrich] dropped ${filteredOut.length}/${beforeFilter} non-player rows from scoring queue`,
      { samples: filteredOut.slice(0, 5).map((p) => p.player_name) })
  }
  if (!props || props.length === 0) {
    await releaseEnrichLock()
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
      const page = await safeQuery(
        supabase
          .from('historical_prop_lines')
          .select('player_name, stat_type, direction, line, game_date')
          .in('player_name', uniqueNames)
          .range(from, from + PAGE - 1),
        'load paged hist lines'
      )
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
    // Paginate — prop_history can exceed 1000 rows per game date (main + alt snapshots)
    const allRows: Record<string, unknown>[] = []
    let from = 0
    const PAGE = 1000
    while (true) {
      const page = await safeQuery(
        supabase
          .from('prop_history')
          .select('player_name, stat_type, direction, odds, game_date')
          .in('game_date', gameDates)
          .range(from, from + PAGE - 1),
        'load morning odds (paged)'
      )
      if (!page || page.length === 0) break
      allRows.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }
    for (const row of allRows) {
      const key = `${row.player_name}|${row.stat_type}|${row.direction}|${row.game_date}`
      if (!map.has(key)) map.set(key, toImpliedProb(row.odds as number | null))
    }
    return map
  }

  // Compute trailing 30-day over hit rate per stat type for calibration gate
  const minGradeDate = new Date(Date.now() - 30 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // Wrap non-essential queries so a single failure (e.g., missing table, Supabase blip)
  // doesn't kill the entire enrichment.  Game logs are critical and allowed to throw.
  const soft = async <T>(p: Promise<T>, fallback: T, label: string): Promise<T> => {
    try { return await p } catch (e) {
      logger.warn(`[/api/enrich] ${label} failed, using fallback`, { err: String(e) })
      return fallback
    }
  }

  const [
    allLogRows,
    histRows,
    defRows,
    dvpRows,
    seasonRows,
    biasRows,
    leakRows,
    positionRows,
    openingOddsMap,
    spreadMap,
    injuryMap,
    yesterdayTeams,
    simRows,
    calibrationRows,
  ] = await Promise.all([
    loadPagedGameLogs(),                                                                          // critical — allowed to throw
    soft(loadPagedHistLines(), [], 'hist lines'),
    soft(safeQuery(supabase.from('team_defense_stats').select('*'), 'load team_defense_stats'), [], 'defense stats'),
    soft(safeQuery(supabase.from('team_defense_vs_position').select('*'), 'load team_defense_vs_position'), [], 'dvp stats'),
    soft(safeQuery(supabase.from('player_season_stats').select('*'), 'load player_season_stats'), [], 'season stats'),
    soft(safeQuery(supabase.from('player_line_bias').select('player_name, stat_type, hit_rate, median_ratio, sample_count'), 'load player_line_bias'), [], 'player bias'),
    soft(safeQuery(supabase.from('opponent_stat_leaks').select('opponent_team, stat_type, over_hit_rate, median_ratio, sample_count'), 'load opponent_stat_leaks'), [], 'opponent leaks'),
    soft(safeQuery(supabase.from('player_positions').select('player_name, position_group'), 'load player_positions'), [], 'player positions'),
    soft(loadMorningOdds(), new Map(), 'morning odds'),
    fetchEspnSpreads(),                                                                           // already has internal try/catch
    fetchEspnInjuries(),                                                                          // already has internal try/catch
    fetchYesterdayTeams(),                                                                        // already has internal try/catch
    soft(safeQuery(supabase.from('sim_3pm').select('player_name, opponent, p_over, p_under, sim_mean, sim_std').eq('game_date', new Date().toISOString().slice(0, 10)), 'load sim_3pm'), [], 'sim 3pm'),
    soft(safeQuery(supabase.from('prop_grades').select('stat_type, direction, hit').gte('game_date', minGradeDate).not('hit', 'is', null), 'load calibration grades'), [], 'calibration grades'),
  ])

  // ── Build over/under hit-rate calibration maps (for bias gates) ──────────
  const overHitRates  = new Map<string, number>()
  const underHitRates = new Map<string, number>()
  {
    const overTally  = new Map<string, { hits: number; total: number }>()
    const underTally = new Map<string, { hits: number; total: number }>()
    for (const row of calibrationRows) {
      const r = row as Record<string, unknown>
      const st = r.stat_type as string
      const dir = r.direction as string
      const tally = dir === 'over' ? overTally : dir === 'under' ? underTally : null
      if (!tally) continue
      if (!tally.has(st)) tally.set(st, { hits: 0, total: 0 })
      const t = tally.get(st)!
      t.total++
      if (r.hit === true) t.hits++
    }
    for (const [st, { hits, total }] of overTally) {
      if (total >= 20) overHitRates.set(st, hits / total)
    }
    for (const [st, { hits, total }] of underTally) {
      if (total >= 20) underHitRates.set(st, hits / total)
    }
  }

  // ── Load today's confirmed lineups (graceful if table missing) ────────────
  // Builds two name-keyed maps used by scoreProps:
  //   starterMap[name] = true   if name is in any team's starters today
  //   outMap[name]     = true   if name is in any team's may_not_play
  // The maps are case/punctuation-insensitive (rotowire uses full names;
  // odds-api props may use display names like "S. Castle").
  const starterMap = new Map<string, boolean>()
  const outMap     = new Map<string, boolean>()
  const lineupStatusMap = new Map<string, 'confirmed' | 'expected' | 'projected' | 'unknown'>()
  try {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const { data: lineupRows } = await supabase
      .from('confirmed_lineups')
      .select('team, status, starters, may_not_play')
      .eq('game_date', todayET)
    for (const row of (lineupRows ?? [])) {
      const status = (row.status as string) === 'unknown' ? 'unknown' : row.status as 'confirmed'|'expected'|'projected'
      for (const s of (row.starters as Array<{ name: string }>) ?? []) {
        starterMap.set(normalizePlayerName(s.name), true)
        lineupStatusMap.set(normalizePlayerName(s.name), status)
      }
      for (const name of (row.may_not_play as string[]) ?? []) {
        outMap.set(normalizePlayerName(name), true)
        lineupStatusMap.set(normalizePlayerName(name), status)
      }
    }
    if (starterMap.size > 0 || outMap.size > 0) {
      logger.info(`[/api/enrich] loaded lineups: ${starterMap.size} starters, ${outMap.size} out`)
    }
  } catch (e) {
    // Table may not exist yet — degrade gracefully (no lineup adjustment)
    logger.warn(`[/api/enrich] confirmed_lineups unavailable: ${String(e).slice(0, 80)}`)
  }

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

  // Build player position map: player name → position group (real NBA positions)
  const positionMap = new Map<string, 'guard' | 'forward' | 'center'>()
  for (const row of positionRows ?? []) {
    if (row.player_name && row.position_group) {
      positionMap.set(row.player_name as string, row.position_group as 'guard' | 'forward' | 'center')
    }
  }
  console.log(`[/api/enrich] Player positions loaded: ${positionMap.size} players`)

  // Build DVP map: team abbreviation → DvpStats (per-position defense ranks)
  const neutral: DvpStats[keyof DvpStats] = { pts: 15, reb: 15, ast: 15, stl: 15, blk: 15, fg3m: 15 }
  const dvpMap = new Map<string, DvpStats>()
  for (const row of dvpRows ?? []) {
    const abbr = row.team_abbreviation as string
    if (!dvpMap.has(abbr)) dvpMap.set(abbr, { guard: { ...neutral }, forward: { ...neutral }, center: { ...neutral } })
    const pos = row.position_group as 'guard' | 'forward' | 'center'
    if (pos === 'guard' || pos === 'forward' || pos === 'center') {
      dvpMap.get(abbr)![pos] = {
        pts:  Number(row.pts_rank),
        reb:  Number(row.reb_rank),
        ast:  Number(row.ast_rank),
        stl:  Number(row.stl_rank),
        blk:  Number(row.blk_rank),
        fg3m: Number(row.fg3m_rank),
      }
    }
  }

  // Build 3PM simulation map: "player_name|opponent" → SimThreePm
  const simMap = new Map<string, SimThreePm>()
  for (const row of simRows ?? []) {
    simMap.set(`${row.player_name}|${row.opponent}`, {
      p_over:   Number(row.p_over),
      p_under:  Number(row.p_under),
      sim_mean: Number(row.sim_mean),
      sim_std:  Number(row.sim_std),
    })
  }
  console.log(`[/api/enrich] 3PM sim results loaded: ${simMap.size} players`)

  const playersWithLogs = [...logsMap.values()].filter((l) => l.length >= 3).length
  const totalsLoaded    = [...spreadMap.values()].filter((g) => g.total != null).length / 2
  console.log(`[/api/enrich] Parallel load done — logs: ${allLogRows.length} rows (${playersWithLogs}/${uniqueNames.length} players), hist: ${histRows.length} rows, ESPN: ${spreadMap.size / 2} games (${totalsLoaded} with O/U), injuries: ${injuryMap.size}, morning odds: ${openingOddsMap.size}, DVP teams: ${dvpMap.size}, positions: ${positionMap.size}, yesterday B2B: ${yesterdayTeams.size}`)

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

    const playerSeasonStats = seasonMap.get(prop.player_name) ?? null
    const playerPosition    = positionMap.get(prop.player_name) ?? inferPlayerPosition(playerSeasonStats)
    const dvpStats          = opponentAbbr ? (dvpMap.get(opponentAbbr) ?? null) : null
    const opponentOnB2B     = opponentAbbr ? yesterdayTeams.has(opponentAbbr) : false
    const homePace          = homeAbbr ? (defMap.get(homeAbbr)?.pace ?? null) : null
    const awayPace          = awayAbbr ? (defMap.get(awayAbbr)?.pace ?? null) : null

    const ctx: ScoringContext = {
      defStats,
      isHome,
      opponentAbbr,
      spread,
      gameTotal,
      playerStatus,
      injuredTeammates,
      seasonStats:      playerSeasonStats,
      historicalLines:  histMap.get(prop.player_name)  ?? [],
      playerBias:       biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
      opponentLeak:     opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
      lineMovementDelta,
      oddsMovementDelta,
      dvpStats,
      playerPosition,
      opponentOnB2B,
      homePace,
      awayPace,
      simThreePm:     prop.stat_type === 'three_pointers' && opponentAbbr
                        ? (simMap.get(`${prop.player_name}|${opponentAbbr}`) ?? null)
                        : null,
      overHitRates,
      underHitRates,
      // Lineup confirmation (rotowire) — see lib/lineups.ts. confirmedStarter
      // resolves to true/false/null based on the maps built above. The score
      // adjustment ±2/-25 is applied in lib/confidence.ts:lineupAdj.
      confirmedStarter: (() => {
        const k = normalizePlayerName(prop.player_name)
        if (outMap.get(k))     return false  // listed as "may not play"
        if (starterMap.get(k)) return true   // in confirmed/expected starters
        return null                          // no lineup data for this player
      })(),
      lineupStatus: (() => {
        return lineupStatusMap.get(normalizePlayerName(prop.player_name)) ?? null
      })(),
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
      const altSeasonStats = seasonMap.get(pseudoProp.player_name) ?? null
      const altPosition    = positionMap.get(pseudoProp.player_name) ?? inferPlayerPosition(altSeasonStats)
      const altDvpStats    = opponentAbbr ? (dvpMap.get(opponentAbbr) ?? null) : null
      const altB2B         = opponentAbbr ? yesterdayTeams.has(opponentAbbr) : false
      const altHomeAbbr    = pseudoProp.home_team ? (TEAM_ABBR[pseudoProp.home_team] ?? null) : null
      const altAwayAbbr    = pseudoProp.away_team ? (TEAM_ABBR[pseudoProp.away_team] ?? null) : null
      const altHomePace    = altHomeAbbr ? (defMap.get(altHomeAbbr)?.pace ?? null) : null
      const altAwayPace    = altAwayAbbr ? (defMap.get(altAwayAbbr)?.pace ?? null) : null

      const ctx: ScoringContext = {
        defStats, isHome, opponentAbbr, spread, gameTotal, playerStatus, injuredTeammates,
        seasonStats:    altSeasonStats,
        playerBias:     biasMap.get(`${pseudoProp.player_name}|${pseudoProp.stat_type}`) ?? null,
        opponentLeak:   opponentAbbr ? (leakMap.get(`${opponentAbbr}|${pseudoProp.stat_type}`) ?? null) : null,
        dvpStats:       altDvpStats,
        playerPosition: altPosition,
        opponentOnB2B:  altB2B,
        homePace:       altHomePace,
        awayPace:       altAwayPace,
        simThreePm:     pseudoProp.stat_type === 'three_pointers' && opponentAbbr
                          ? (simMap.get(`${pseudoProp.player_name}|${opponentAbbr}`) ?? null)
                          : null,
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

      return { ...alt, confidence_score: adjScore, confidence_label: getLabel(adjScore, pseudoProp.stat_type).label }
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
    const parlayRes = await fetch(`${baseUrl}/api/feed/generate/parlay?date=${parlayGameDate}`, { method: 'POST' })
    if (!parlayRes.ok) logger.warn('[/api/enrich] parlay generation returned non-OK', { status: parlayRes.status })
  } catch (e) {
    logger.error('[/api/enrich] parlay generation failed', { err: String(e) })
  }

  const injuredCount = [...injuryMap.values()].filter((i) => i.status !== 'active').length

  await releaseEnrichLock()

  return {
    message: `Enriched ${enriched} props + ${enrichedAlts} alt lines`,
    enriched,
    enrichedAlts,
    snapshotted,
    total: props.length,
    playersWithGameLogs: playersWithLogs,
    teamsWithDefenseData: defMap.size,
    teamsWithDvpData: dvpMap.size,
    teamsOnB2B: yesterdayTeams.size,
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
    await releaseEnrichLock()
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
    await releaseEnrichLock()
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('[/api/enrich] Error', { err: message })
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}
