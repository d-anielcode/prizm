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

  if (force) {
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

  // ── Fetch real-time data (spreads + injuries) in parallel ─────────────────
  console.log('[/api/enrich] Fetching ESPN spreads + injury report...')
  const [spreadMap, injuryMap] = await Promise.all([
    fetchEspnSpreads(),
    fetchEspnInjuries(),
  ])
  const totalsLoaded = [...spreadMap.values()].filter((g) => g.total != null).length / 2
  console.log(`[/api/enrich] ESPN: ${spreadMap.size / 2} games (${totalsLoaded} with O/U totals), ${injuryMap.size} injured players`)

  // ── Load game logs from Supabase (paginated — 78 players × 66 games > 1000 row limit) ──
  const uniqueNames = [...new Set(props.map((p) => p.player_name))]
  console.log(`[/api/enrich] Loading game logs for ${uniqueNames.length} players...`)

  const allLogRows: Record<string, unknown>[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page, error: pageErr } = await supabase
        .from('player_game_logs')
        .select('*')
        .in('player_name', uniqueNames)
        .order('game_date', { ascending: false })
        .range(from, from + PAGE - 1)
      if (pageErr) { console.error('[/api/enrich] game log page error:', pageErr.message); break }
      if (!page || page.length === 0) break
      allLogRows.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[/api/enrich] Loaded ${allLogRows.length} game log rows`)

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

  const playersWithLogs = [...logsMap.values()].filter((l) => l.length >= 3).length
  console.log(`[/api/enrich] Game logs: ${playersWithLogs}/${uniqueNames.length} players`)

  // ── Load historical prop lines (actual market lines for past games) ────────
  const histRows: Record<string, unknown>[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name, stat_type, direction, line, game_date')
        .in('player_name', uniqueNames)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      histRows.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  // Index by player_name → HistoricalLine[]
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
  console.log(`[/api/enrich] Historical lines: ${histRows.length} rows for ${histMap.size} players`)

  // ── Load team defensive rankings ──────────────────────────────────────────
  const { data: defRows } = await supabase.from('team_defense_stats').select('*')
  const defMap = new Map<string, TeamDefenseStats>()
  for (const row of defRows ?? []) {
    defMap.set(row.team_abbreviation as string, row as TeamDefenseStats)
  }
  console.log(`[/api/enrich] Team defense stats: ${defMap.size} teams`)

  // ── Load season stats ──────────────────────────────────────────────────────
  const { data: seasonRows } = await supabase.from('player_season_stats').select('*')
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
  console.log(`[/api/enrich] Season stats: ${seasonMap.size} players`)

  // ── Load player line bias ──────────────────────────────────────────────────
  const { data: biasRows } = await supabase
    .from('player_line_bias')
    .select('player_name, stat_type, hit_rate, median_ratio, sample_count')
  // Index by "player|stat" for O(1) lookup
  const biasMap = new Map<string, PlayerLineBias>()
  for (const row of biasRows ?? []) {
    biasMap.set(`${row.player_name}|${row.stat_type}`, {
      hit_rate:     Number(row.hit_rate),
      median_ratio: Number(row.median_ratio),
      sample_count: Number(row.sample_count),
    })
  }
  console.log(`[/api/enrich] Line bias: ${biasMap.size} player/stat entries`)

  // ── Load opponent stat leaks ───────────────────────────────────────────────
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
  console.log(`[/api/enrich] Opponent leaks: ${leakMap.size} team/stat entries`)

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

    const ctx: ScoringContext = {
      defStats,
      isHome,
      opponentAbbr,
      spread,
      gameTotal,
      playerStatus,
      injuredTeammates,
      seasonStats:     seasonMap.get(prop.player_name) ?? null,
      historicalLines: histMap.get(prop.player_name)  ?? [],
      playerBias:      biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
      opponentLeak:    opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
    }

    return scoreProps(prop, logs, null, ctx)
  })

  // ── Batch-upsert main props to Supabase ──────────────────────────────────
  let enriched = 0
  const BATCH = 200
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
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
      const ctx: ScoringContext = { defStats, isHome, opponentAbbr, spread, gameTotal, playerStatus, injuredTeammates }
      const scored = scoreProps(pseudoProp, logs, null, ctx)
      return { ...alt, confidence_score: scored.confidence_score, confidence_label: scored.confidence_label }
    })

    for (let i = 0; i < altUpdates.length; i += BATCH) {
      const batch = altUpdates.slice(i, i + BATCH)
      const { error } = await supabase.from('prop_alts').upsert(batch, { onConflict: 'id' })
      if (!error) enrichedAlts += batch.length
      else console.error('[/api/enrich] prop_alts upsert error:', error.message)
    }
  }

  const injuredCount = [...injuryMap.values()].filter((i) => i.status !== 'active').length

  return {
    message: `Enriched ${enriched} props + ${enrichedAlts} alt lines`,
    enriched,
    enrichedAlts,
    total: props.length,
    playersWithGameLogs: playersWithLogs,
    teamsWithDefenseData: defMap.size,
    espnSpreadsLoaded: spreadMap.size / 2,
    espnInjuriesLoaded: injuredCount,
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}
