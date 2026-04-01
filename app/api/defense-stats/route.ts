// /api/defense-stats — Fetch NBA team defensive stats from stats.nba.com and upsert to Supabase.
// Populates team_defense_stats (season ranks, L15 ranks, pace) and team_defense_vs_position (DVP).
// Run before /api/enrich so the confidence model has fresh DVP/pace data.

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireCronAuth } from '@/lib/api-auth'
import { CURRENT_SEASON } from '@/lib/constants'

export const maxDuration = 60

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
}

const STAT_COLS: Record<string, string> = {
  pts_rank:  'OPP_PTS',
  reb_rank:  'OPP_REB',
  ast_rank:  'OPP_AST',
  blk_rank:  'OPP_BLK',
  stl_rank:  'OPP_STL',
  fg3m_rank: 'OPP_FG3M',
}

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } },
  )
}

function buildNbaUrl(base: string, params: Record<string, string | number>) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${base}?${qs}`
}

function buildTeamStatsUrl(params: Record<string, string | number>) {
  const defaults = {
    Conference: '', DateFrom: '', DateTo: '', Division: '',
    GameScope: '', GameSegment: '', Height: '', LastNGames: 0,
    LeagueID: '00', Location: '', Month: 0, OpponentTeamID: 0,
    Outcome: '', PORound: 0, PaceAdjust: 'N', PerMode: 'PerGame',
    Period: 0, PlayerExperience: '', PlayerPosition: '',
    PlusMinus: 'N', Rank: 'N', Season: CURRENT_SEASON,
    SeasonSegment: '', SeasonType: 'Regular Season',
    ShotClockRange: '', StarterBench: '', TeamID: 0,
    TwoWay: 0, VsConference: '', VsDivision: '',
  }
  return buildNbaUrl('https://stats.nba.com/stats/leaguedashteamstats', { ...defaults, ...params })
}

async function fetchNbaJson(url: string): Promise<{ headers: string[]; rows: unknown[][] } | null> {
  const res = await fetch(url, { headers: NBA_HEADERS, cache: 'no-store' })
  if (!res.ok) {
    console.error(`[defense-stats] NBA API error: ${res.status} ${url.slice(0, 120)}`)
    return null
  }
  const json = await res.json()
  const set = json?.resultSets?.[0]
  if (!set) return null
  return { headers: set.headers as string[], rows: set.rowSet as unknown[][] }
}

async function fetchNbaStats(params: Record<string, string | number>): Promise<{ headers: string[]; rows: unknown[][] } | null> {
  return fetchNbaJson(buildTeamStatsUrl(params))
}

/** Map raw NBA position string → position group */
function mapPosition(raw: string): 'guard' | 'forward' | 'center' {
  const p = (raw ?? '').trim().toUpperCase()
  if (p === 'C' || p === 'C-F') return 'center'
  if (p === 'G' || p === 'G-F' || p === 'F-G') return 'guard'
  return 'forward'  // F, F-C, F-G, unknown
}

function toMap(data: { headers: string[]; rows: unknown[][] }): Record<string, Record<string, unknown>>[] {
  return data.rows.map(row =>
    Object.fromEntries(data.headers.map((h, i) => [h, row[i]])) as Record<string, unknown>
  ) as Record<string, Record<string, unknown>>[]
}

function computeRanks(rows: Record<string, unknown>[], rankMap: Record<string, string>): void {
  for (const [rankCol, rawCol] of Object.entries(rankMap)) {
    const sorted = [...rows]
      .map(r => ({ abbr: r['TEAM_ABBREVIATION'] as string, val: Number(r[rawCol] ?? 0) }))
      .sort((a, b) => a.val - b.val)
    const ranks: Record<string, number> = {}
    sorted.forEach(({ abbr }, i) => { ranks[abbr] = i + 1 })
    for (const row of rows) {
      row[rankCol] = ranks[row['TEAM_ABBREVIATION'] as string] ?? 15
    }
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const db = getDb()
  const now = new Date().toISOString()
  const results: Record<string, unknown> = {}

  // ── Phase 1: Season stats (required first — other calls are independent) ──
  console.log('[defense-stats] Fetching season opponent stats...')
  const seasonData = await fetchNbaStats({ MeasureType: 'Opponent', LastNGames: 0 })
  if (!seasonData) return NextResponse.json({ error: 'Failed to fetch season stats from NBA API' }, { status: 502 })

  const teamRows: Record<string, unknown>[] = toMap(seasonData).map(row => ({
    team_abbreviation: row['TEAM_ABBREVIATION'],
    fetched_at: now,
    ...Object.fromEntries(Object.values(STAT_COLS).map(col => [col, Number(row[col] ?? 0)])),
  }))
  computeRanks(teamRows, STAT_COLS)
  for (const row of teamRows) {
    for (const col of Object.values(STAT_COLS)) delete row[col]
  }
  results.seasonTeams = teamRows.length

  // ── Phase 2: L15 + pace + DVP (guard/forward/center) + player positions — all parallel ──
  console.log('[defense-stats] Fetching L15, pace, DVP x3, player positions in parallel...')

  const playerBioUrl = buildNbaUrl('https://stats.nba.com/stats/leaguedashplayerbiostats', {
    LeagueID: '00', Season: CURRENT_SEASON, SeasonType: 'Regular Season',
    PerMode: 'PerGame', College: '', Conference: '', Country: '', DateFrom: '',
    DateTo: '', Division: '', DraftPick: '', DraftYear: '', GameScope: '',
    GameSegment: '', Height: '', LastNGames: 0, Location: '', Month: 0,
    OpponentTeamID: 0, Outcome: '', PORound: 0, Period: 0,
    PlayerExperience: '', PlayerPosition: '', SeasonSegment: '',
    ShotClockRange: '', StarterBench: '', TeamID: 0, VsConference: '',
    VsDivision: '', Weight: '',
  })

  const [l15Data, paceData, dvpG, dvpF, dvpC, bioData] = await Promise.all([
    fetchNbaStats({ MeasureType: 'Opponent', LastNGames: 15 }),
    fetchNbaStats({ MeasureType: 'Base', LastNGames: 0 }),
    fetchNbaStats({ MeasureType: 'Opponent', PlayerPosition: 'G', LastNGames: 0 }),
    fetchNbaStats({ MeasureType: 'Opponent', PlayerPosition: 'F', LastNGames: 0 }),
    fetchNbaStats({ MeasureType: 'Opponent', PlayerPosition: 'C', LastNGames: 0 }),
    fetchNbaJson(playerBioUrl),
  ])

  // Merge L15 ranks into teamRows
  if (l15Data) {
    const L15_COLS = Object.fromEntries(
      Object.entries(STAT_COLS).map(([k, v]) => [k.replace('_rank', '_rank_l15'), v])
    )
    const l15Rows: Record<string, unknown>[] = toMap(l15Data).map(row => ({
      team_abbreviation: row['TEAM_ABBREVIATION'],
      ...Object.fromEntries(Object.values(L15_COLS).map(col => [col, Number(row[col] ?? 0)])),
    }))
    computeRanks(l15Rows, L15_COLS)
    const l15ByAbbr: Record<string, Record<string, unknown>> = {}
    for (const r of l15Rows) {
      l15ByAbbr[r['team_abbreviation'] as string] = r
      for (const col of Object.values(L15_COLS)) delete r[col]
    }
    for (const row of teamRows) {
      const l15 = l15ByAbbr[row['team_abbreviation'] as string] ?? {}
      for (const col of Object.keys(L15_COLS)) {
        row[col] = l15[col] ?? row[col.replace('_l15', '')] ?? 15
      }
    }
    results.l15Merged = true
  }

  // Merge pace into teamRows
  if (paceData) {
    const paceByAbbr: Record<string, number> = {}
    for (const row of toMap(paceData)) {
      paceByAbbr[String(row['TEAM_ABBREVIATION'])] = Number(row['PACE'] ?? 0)
    }
    for (const row of teamRows) {
      row['pace'] = paceByAbbr[String(row['team_abbreviation'])] ?? null
    }
    results.paceMerged = true
  }

  // Upsert team_defense_stats
  const { error: defErr } = await db
    .from('team_defense_stats')
    .upsert(teamRows, { onConflict: 'team_abbreviation' })
  if (defErr) console.error('[defense-stats] upsert team_defense_stats error:', defErr.message)
  else console.log(`[defense-stats] Saved ${teamRows.length} rows to team_defense_stats`)

  // Build and upsert DVP rows
  const dvpRows: Record<string, unknown>[] = []
  for (const [data, label] of [[dvpG, 'guard'], [dvpF, 'forward'], [dvpC, 'center']] as const) {
    if (!data) { console.warn(`[defense-stats] DVP fetch failed for ${label}`); continue }
    const posRows: Record<string, unknown>[] = toMap(data).map(row => ({
      team_abbreviation: row['TEAM_ABBREVIATION'],
      position_group: label,
      fetched_at: now,
      ...Object.fromEntries(Object.values(STAT_COLS).map(col => [col, Number(row[col] ?? 0)])),
    }))
    computeRanks(posRows, STAT_COLS)
    for (const row of posRows) {
      for (const col of Object.values(STAT_COLS)) delete row[col]
    }
    dvpRows.push(...posRows)
    console.log(`[defense-stats] DVP ${label}: ${posRows.length} teams`)
  }

  if (dvpRows.length > 0) {
    const { error: dvpErr } = await db
      .from('team_defense_vs_position')
      .upsert(dvpRows, { onConflict: 'team_abbreviation,position_group' })
    if (dvpErr) console.error('[defense-stats] upsert team_defense_vs_position error:', dvpErr.message)
    else console.log(`[defense-stats] Saved ${dvpRows.length} DVP rows`)
  }
  results.dvpRows = dvpRows.length

  // Upsert player positions
  if (bioData) {
    const nameIdx = bioData.headers.indexOf('PLAYER_NAME')
    const posIdx  = bioData.headers.indexOf('PLAYER_POSITION')
    if (nameIdx >= 0 && posIdx >= 0) {
      const posRows = bioData.rows
        .filter(row => row[nameIdx] && row[posIdx])
        .map(row => ({
          player_name:    String(row[nameIdx]),
          nba_position:   String(row[posIdx]),
          position_group: mapPosition(String(row[posIdx])),
          updated_at:     now,
        }))
      let posUpserted = 0
      for (let i = 0; i < posRows.length; i += 500) {
        const chunk = posRows.slice(i, i + 500)
        const { error: posErr } = await db
          .from('player_positions')
          .upsert(chunk, { onConflict: 'player_name' })
        if (posErr) console.error('[defense-stats] upsert player_positions error:', posErr.message)
        else posUpserted += chunk.length
      }
      results.playerPositions = posUpserted
      console.log(`[defense-stats] Saved ${posUpserted} player positions`)
    } else {
      console.warn('[defense-stats] PLAYER_NAME or PLAYER_POSITION not found in bio stats response')
    }
  } else {
    console.warn('[defense-stats] Failed to fetch player bio stats — positions not updated')
  }

  return NextResponse.json({
    ok: true,
    ...results,
    message: `Defense stats updated: ${teamRows.length} teams, ${dvpRows.length} DVP rows, ${results.playerPositions ?? 0} player positions`,
  })
}
