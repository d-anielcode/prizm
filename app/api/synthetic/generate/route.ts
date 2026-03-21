// /api/synthetic/generate
//
// Generates synthetic prop lines for a date range using the line-setting ratios
// derived from /api/synthetic/analyze. Lines are stored in synthetic_prop_lines.
//
// GET /api/synthetic/generate?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=N
//   start   — first date to generate (default: 2025-12-01)
//   end     — last date to generate  (default: 2026-02-03)
//   limit   — max dates per call     (default: 7, max: 14)
//
// Call repeatedly following the returned nextUrl until done: true.
// Each call: loads game logs for [limit] dates, computes L10 averages,
// applies median ratio, rounds to nearest 0.5, upserts to synthetic_prop_lines.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { dateRange } from '@/lib/espn-gamelogs'

export const maxDuration = 60

// Calibrated median ratios from /api/synthetic/analyze
const MEDIAN_RATIO: Record<string, number> = {
  points:         0.991,
  rebounds:       1.000,
  assists:        0.972,
  pra:            1.004,
  blocks:         0.938,
  steals:         1.000,
  three_pointers: 0.938,
}

// Minimum L10 average required to generate a line for this stat
// (avoids generating blocks lines for guards, steals lines for bigs, etc.)
const MIN_AVG: Record<string, number> = {
  points:         5.0,
  rebounds:       2.0,
  assists:        1.5,
  pra:            10.0,
  blocks:         0.5,
  steals:         0.5,
  three_pointers: 0.5,
}

// game_logs column for each stat type
const STAT_COL: Record<string, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  pra:            'pra',
  blocks:         'blocks',
  steals:         'steals',
  three_pointers: 'fg3m',
}

const STAT_TYPES = Object.keys(MEDIAN_RATIO)

/** Round to nearest 0.5 — sportsbooks always use half-point lines */
function roundHalf(v: number): number {
  return Math.round(v * 2) / 2
}

export async function GET(req: Request) {
  const url   = new URL(req.url)
  const start = url.searchParams.get('start') ?? '2025-12-01'
  const end   = url.searchParams.get('end')   ?? '2026-02-03'
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '7'), 14)

  const allDates   = dateRange(start, end)
  const batch      = allDates.slice(0, limit)
  const nextDate   = allDates[limit] ?? null

  if (batch.length === 0) {
    return NextResponse.json({ done: true, message: 'No dates to process', totalUpserted: 0 })
  }

  // ── 0. Load the set of players sportsbooks actually offer props for ───────────
  // Only generate synthetic lines for these players — fringe/two-way players
  // that books never price would add noise and skew backtest hit rates.
  const eligiblePlayers = new Set<string>()
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name')
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) eligiblePlayers.add(row.player_name as string)
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[synthetic/generate] ${eligiblePlayers.size} eligible players from historical_prop_lines`)

  // ── 1. Load all game logs for the batch dates + 90 days prior ────────────────
  // We need prior logs to compute L10 averages. The earliest prior date is
  // 90 days before the first batch date.
  const priorStart = new Date(new Date(batch[0] + 'T12:00:00Z').getTime() - 90 * 86400000)
    .toISOString().slice(0, 10)

  // Load all logs in the window (prior + batch dates)
  const allLogs: Array<{
    player_name: string
    game_date:   string
    matchup:     string
    points:      number
    rebounds:    number
    assists:     number
    pra:         number
    blocks:      number
    steals:      number
    fg3m:        number
  }> = []

  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, matchup, points, rebounds, assists, pra, blocks, steals, fg3m')
        .gte('game_date', priorStart)
        .lte('game_date', batch[batch.length - 1])
        .order('game_date', { ascending: false })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) allLogs.push(row as typeof allLogs[0])
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // Build index: player → logs sorted descending by date
  const logsByPlayer = new Map<string, typeof allLogs>()
  for (const log of allLogs) {
    if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
    logsByPlayer.get(log.player_name)!.push(log)
  }
  // Already sorted descending from query

  // ── 2. For each batch date, generate synthetic lines ────────────────────────
  const toUpsert: Array<{
    game_date:    string
    player_name:  string
    stat_type:    string
    direction:    string
    line:         number
    home_team:    string | null
    away_team:    string | null
    commence_time: string | null
  }> = []

  for (const date of batch) {
    // Find all players who played on this date
    const playersOnDate = allLogs.filter((l) => l.game_date === date)
    // Dedupe by player (each player appears once per game)
    const seenPlayers = new Set<string>()
    const uniquePlayers: typeof allLogs = []
    for (const log of playersOnDate) {
      if (!seenPlayers.has(log.player_name)) {
        seenPlayers.add(log.player_name)
        uniquePlayers.push(log)
      }
    }

    for (const playerLog of uniquePlayers) {
      const { player_name, matchup } = playerLog
      // Skip fringe players that sportsbooks never offer props for
      if (!eligiblePlayers.has(player_name)) continue

      // Parse home/away from matchup string e.g. "BOS vs. MIA" or "BOS @ MIA"
      let home_team: string | null = null
      let away_team: string | null = null
      if (matchup.includes(' vs. ')) {
        const [team, opp] = matchup.split(' vs. ')
        home_team = team?.trim() ?? null
        away_team = opp?.trim() ?? null
      } else if (matchup.includes(' @ ')) {
        const [team, opp] = matchup.split(' @ ')
        away_team = team?.trim() ?? null
        home_team = opp?.trim() ?? null
      }

      // Approximate commence time: 7:30 PM ET on game date
      const commence_time = `${date}T23:30:00+00:00`

      // Get prior logs (strictly before this date) for L10 calculation
      const priorLogs = (logsByPlayer.get(player_name) ?? [])
        .filter((l) => l.game_date < date)

      if (priorLogs.length < 5) continue // not enough history

      const l10 = priorLogs.slice(0, 10)

      for (const statType of STAT_TYPES) {
        const col = STAT_COL[statType]
        const ratio = MEDIAN_RATIO[statType]
        const minAvg = MIN_AVG[statType]

        const avg = l10.reduce((s, g) => s + (g[col as keyof typeof g] as number), 0) / l10.length
        if (avg < minAvg) continue // player doesn't typically get this prop

        const rawLine = avg * ratio
        const line = roundHalf(rawLine)
        if (line < 0.5) continue // sanity floor

        // Generate OVER and UNDER at the same line
        toUpsert.push({ game_date: date, player_name, stat_type: statType, direction: 'over',  line, home_team, away_team, commence_time })
        toUpsert.push({ game_date: date, player_name, stat_type: statType, direction: 'under', line, home_team, away_team, commence_time })
      }
    }
  }

  // ── 3. Upsert in batches of 500 ───────────────────────────────────────────
  const BATCH = 500
  let totalUpserted = 0
  for (let i = 0; i < toUpsert.length; i += BATCH) {
    const slice = toUpsert.slice(i, i + BATCH)
    const { error } = await supabase
      .from('synthetic_prop_lines')
      .upsert(slice, { onConflict: 'game_date,player_name,stat_type,direction' })
    if (!error) totalUpserted += slice.length
    else console.error('[synthetic/generate] upsert error:', error.message)
  }

  const done = nextDate === null
  const nextUrl = done
    ? null
    : `${new URL(req.url).origin}/api/synthetic/generate?start=${nextDate}&end=${end}&limit=${limit}`

  console.log(`[synthetic/generate] ${batch[0]}–${batch[batch.length - 1]}: ${toUpsert.length} rows generated, ${totalUpserted} upserted`)

  return NextResponse.json({
    done,
    message: done
      ? `Generation complete — ${totalUpserted} synthetic prop lines inserted`
      : `Processed ${batch.length} dates (${totalUpserted} rows). Follow nextUrl to continue.`,
    datesProcessed: batch,
    rowsGenerated:  toUpsert.length,
    totalUpserted,
    next:    nextDate,
    nextUrl,
    remaining: Math.max(0, allDates.length - limit),
  })
}
