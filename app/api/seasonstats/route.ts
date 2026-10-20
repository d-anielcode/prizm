// /api/seasonstats — Compute season averages from player_game_logs and store in player_season_stats
// Run after gamelogs have been backfilled for the season.
// Cron: daily after gamelogs (see vercel.json)
//
// Optional ?player=NAME param: compute stats for just one player (efficient — no full table scan)

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getEspnVariants } from '@/lib/player-aliases'
import { CURRENT_SEASON } from '@/lib/constants'
import { seasonDateRange, SEASON_ID_RE, groupSeasonLogs, type SeasonLogGroup } from '@/lib/season'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

export const maxDuration = 120

const PAGE   = 1000

function avg(arr: number[]): number | null {
  return arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null
}

type LogRow = {
  player_name: string; nba_id: string | number | null; game_date: string
  points: number | null; rebounds: number | null; assists: number | null; steals: number | null
  blocks: number | null; fg3m: number | null; pra: number | null; minutes: number | null
}

const LOG_COLUMNS = 'player_name, nba_id, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes'

function buildRow(g: SeasonLogGroup<LogRow>, now: string, season: string) {
  const gp = g.logs.length
  if (gp < 1) return null
  const col = (k: keyof LogRow) => avg(g.logs.map((l) => Number(l[k] ?? 0)))
  return {
    nba_id:       g.nba_id,
    player_name:  g.player_name,
    season,
    games_played: gp,
    avg_points:   col('points'),
    avg_rebounds: col('rebounds'),
    avg_assists:  col('assists'),
    avg_steals:   col('steals'),
    avg_blocks:   col('blocks'),
    avg_fg3m:     col('fg3m'),
    avg_pra:      col('pra'),
    avg_minutes:  col('minutes'),
    fetched_at:   now,
  }
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url       = new URL(req.url)
  const playerArg = url.searchParams.get('player')?.trim()
  // ?season=2025-26 recomputes a past season; default is the current one.
  const season    = url.searchParams.get('season') ?? CURRENT_SEASON
  if (!SEASON_ID_RE.test(season)) {
    return NextResponse.json({ error: `Invalid season "${season}" (expected e.g. 2026-27)` }, { status: 400 })
  }
  // Only this season's games — the table holds several seasons of logs.
  const { start, end } = seasonDateRange(season)

  try {
    const now  = new Date().toISOString()
    const logs: LogRow[] = []

    if (playerArg) {
      // ── Single-player mode: efficient lookup for one player ──────────────────
      const nameVariants = getEspnVariants(playerArg)

      let from = 0
      while (true) {
        const { data: page, error } = await supabase
          .from('player_game_logs')
          .select(LOG_COLUMNS)
          .in('player_name', nameVariants)
          .gte('game_date', start)
          .lte('game_date', end)
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        if (!page || page.length === 0) break
        logs.push(...page)
        if (page.length < PAGE) break
        from += PAGE
      }

      if (logs.length === 0) {
        return NextResponse.json({
          message: `No game logs found for "${playerArg}". Run /api/gamelogs first.`,
          player: playerArg,
          rows: 0,
        })
      }

      // All variants count under the requested name; each game date once.
      const [group] = groupSeasonLogs(logs.map((l) => ({ ...l, player_name: playerArg })))
      const row = group ? buildRow(group, now, season) : null
      if (!row) {
        return NextResponse.json({ message: 'Insufficient data', player: playerArg, rows: 0 })
      }

      const { error: upsertErr } = await supabase
        .from('player_season_stats')
        .upsert([row], { onConflict: 'nba_id,season' })

      if (upsertErr) throw new Error(upsertErr.message)

      return NextResponse.json({
        message: `Season stats computed for ${playerArg} (${logs.length} game logs, ${row.games_played} games played)`,
        player: playerArg,
        stats:  row,
      })
    }

    // ── Full-season mode: compute stats for all players ──────────────────────
    let from = 0
    while (true) {
      const { data: page, error: logsError } = await supabase
        .from('player_game_logs')
        .select(LOG_COLUMNS)
        .gte('game_date', start)
        .lte('game_date', end)
        .order('id')
        .range(from, from + PAGE - 1)
      if (logsError) throw new Error(logsError.message)
      if (!page || page.length === 0) break
      logs.push(...page)
      if (page.length < PAGE) break
      from += PAGE
    }

    if (logs.length === 0) {
      // No games yet this season: drop stale rows so enrich falls back to last season.
      const { error: clearErr } = await supabase.from('player_season_stats').delete().eq('season', season)
      if (clearErr) throw new Error(clearErr.message)
      return NextResponse.json({ message: `No ${season} game logs yet — cleared ${season} season stats`, season, rows: 0 })
    }

    // One row per player, matched across id systems and spellings (see groupSeasonLogs).
    // Names that don't normalize together ("Paul Reed" / "Paul Reed Jr") can still share an
    // nba_id; keep the bigger sample so no batch has a duplicate upsert key.
    const byId = new Map<string, NonNullable<ReturnType<typeof buildRow>>>()
    for (const group of groupSeasonLogs(logs)) {
      const row = buildRow(group, now, season)
      if (row && row.games_played > (byId.get(row.nba_id)?.games_played ?? 0)) byId.set(row.nba_id, row)
    }
    const rows = [...byId.values()]

    console.log(`[/api/seasonstats] Computing averages for ${rows.length} players from ${logs.length} game logs...`)

    // Upsert in batches
    const BATCH = 200
    let upserted = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const { error } = await supabase
        .from('player_season_stats')
        .upsert(slice, { onConflict: 'nba_id,season' })
      if (!error) upserted += slice.length
      else console.error('[/api/seasonstats] upsert error:', error.message)
    }

    // Remove rows for players with no games in this season's window (only after a clean upsert).
    if (upserted === rows.length) {
      const { error: pruneErr } = await supabase
        .from('player_season_stats')
        .delete()
        .eq('season', season)
        .lt('fetched_at', now)
      if (pruneErr) console.error('[/api/seasonstats] prune error:', pruneErr.message)
    }

    return NextResponse.json({
      message: `Computed ${season} season stats for ${upserted} players from ${logs.length} game logs`,
      season,
      players: upserted,
      gameLogs: logs.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[/api/seasonstats]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
