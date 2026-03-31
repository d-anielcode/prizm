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

function buildNbaUrl(params: Record<string, string | number>) {
  const base = 'https://stats.nba.com/stats/leaguedashteamstats'
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
  const merged = { ...defaults, ...params }
  const qs = Object.entries(merged)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${base}?${qs}`
}

async function fetchNbaStats(params: Record<string, string | number>): Promise<{ headers: string[]; rows: unknown[][] } | null> {
  const url = buildNbaUrl(params)
  const res = await fetch(url, { headers: NBA_HEADERS, cache: 'no-store' })
  if (!res.ok) {
    console.error(`[defense-stats] NBA API error: ${res.status} ${url.slice(0, 100)}`)
    return null
  }
  const json = await res.json()
  const set = json?.resultSets?.[0]
  if (!set) return null
  return { headers: set.headers as string[], rows: set.rowSet as unknown[][] }
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

  // ── 1. Season-long opponent stats ────────────────────────────────────────
  console.log('[defense-stats] Fetching season opponent stats...')
  const seasonData = await fetchNbaStats({ MeasureType: 'Opponent', LastNGames: 0 })
  if (!seasonData) return NextResponse.json({ error: 'Failed to fetch season stats from NBA API' }, { status: 502 })

  const teamRows: Record<string, unknown>[] = toMap(seasonData).map(row => ({
    team_abbreviation: row['TEAM_ABBREVIATION'],
    fetched_at: now,
    ...Object.fromEntries(Object.values(STAT_COLS).map(col => [col, Number(row[col] ?? 0)])),
  }))
  computeRanks(teamRows, STAT_COLS)
  // Rename raw cols to rank cols (raw values no longer needed in DB)
  for (const row of teamRows) {
    for (const col of Object.values(STAT_COLS)) delete row[col]
  }
  results.seasonTeams = teamRows.length

  // ── 2. L15 opponent stats ─────────────────────────────────────────────────
  await sleep(1000)
  console.log('[defense-stats] Fetching L15 opponent stats...')
  const l15Data = await fetchNbaStats({ MeasureType: 'Opponent', LastNGames: 15 })
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
      for (const col of Object.values(L15_COLS)) delete r[col]  // clean raw cols
    }
    for (const row of teamRows) {
      const l15 = l15ByAbbr[row['team_abbreviation'] as string] ?? {}
      for (const col of Object.keys(L15_COLS)) {
        row[col] = l15[col] ?? row[col.replace('_l15', '')] ?? 15
      }
    }
    results.l15Merged = true
  }

  // ── 3. Pace (Base stats) ─────────────────────────────────────────────────
  await sleep(1000)
  console.log('[defense-stats] Fetching pace...')
  const paceData = await fetchNbaStats({ MeasureType: 'Base', LastNGames: 0 })
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

  // ── 4. DVP by position ───────────────────────────────────────────────────
  const positions: Array<{ label: string; abbr: string }> = [
    { label: 'guard', abbr: 'G' },
    { label: 'forward', abbr: 'F' },
    { label: 'center', abbr: 'C' },
  ]
  const dvpRows: Record<string, unknown>[] = []

  for (const { label, abbr } of positions) {
    await sleep(1000)
    console.log(`[defense-stats] Fetching DVP (${label})...`)
    const dvpData = await fetchNbaStats({ MeasureType: 'Opponent', PlayerPosition: abbr, LastNGames: 0 })
    if (!dvpData) {
      console.warn(`[defense-stats] DVP fetch failed for ${label}`)
      continue
    }
    const posRows: Record<string, unknown>[] = toMap(dvpData).map(row => ({
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
    console.log(`[defense-stats] ${label}: ${posRows.length} teams`)
  }

  if (dvpRows.length > 0) {
    const { error: dvpErr } = await db
      .from('team_defense_vs_position')
      .upsert(dvpRows, { onConflict: 'team_abbreviation,position_group' })
    if (dvpErr) console.error('[defense-stats] upsert team_defense_vs_position error:', dvpErr.message)
    else console.log(`[defense-stats] Saved ${dvpRows.length} DVP rows`)
  }

  results.dvpRows = dvpRows.length

  return NextResponse.json({
    ok: true,
    ...results,
    message: `Defense stats updated: ${teamRows.length} teams, ${dvpRows.length} DVP rows`,
  })
}
