// /api/seasonstats — Compute season averages from player_game_logs and store in player_season_stats
// Run after gamelogs have been backfilled for the season.
// Cron: daily after gamelogs (see vercel.json)
//
// Optional ?player=NAME param: compute stats for just one player (efficient — no full table scan)

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getEspnVariants } from '@/lib/player-aliases'
import { CURRENT_SEASON } from '@/lib/constants'
import { seasonDateRange, SEASON_ID_RE } from '@/lib/season'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

export const maxDuration = 120

const PAGE   = 1000

function avg(arr: number[]): number | null {
  return arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null
}

interface PlayerAccum {
  nba_id: string | null
  pts:  number[]; reb:  number[]; ast: number[]
  stl:  number[]; blk:  number[]; fg3m: number[]
  pra:  number[]; min:  number[]
}

function buildRow(
  player_name: string,
  d: PlayerAccum,
  now: string,
  season: string,
) {
  const gp = d.pts.length
  if (gp < 1) return null
  return {
    nba_id:       d.nba_id ?? `local_${player_name}`,
    player_name,
    season,
    games_played: gp,
    avg_points:   avg(d.pts),
    avg_rebounds: avg(d.reb),
    avg_assists:  avg(d.ast),
    avg_steals:   avg(d.stl),
    avg_blocks:   avg(d.blk),
    avg_fg3m:     avg(d.fg3m),
    avg_pra:      avg(d.pra),
    avg_minutes:  avg(d.min),
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
    const logs: Record<string, unknown>[] = []

    if (playerArg) {
      // ── Single-player mode: efficient lookup for one player ──────────────────
      const nameVariants = getEspnVariants(playerArg)

      let from = 0
      while (true) {
        const { data: page, error } = await supabase
          .from('player_game_logs')
          .select('player_name, nba_id, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
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

      // Aggregate (all variants counted under the requested name)
      const accum: PlayerAccum = {
        nba_id: (logs[0]?.nba_id as string | null) ?? null,
        pts: [], reb: [], ast: [], stl: [], blk: [], fg3m: [], pra: [], min: [],
      }
      for (const log of logs) {
        accum.pts.push(Number(log.points   ?? 0))
        accum.reb.push(Number(log.rebounds ?? 0))
        accum.ast.push(Number(log.assists  ?? 0))
        accum.stl.push(Number(log.steals   ?? 0))
        accum.blk.push(Number(log.blocks   ?? 0))
        accum.fg3m.push(Number(log.fg3m    ?? 0))
        accum.pra.push(Number(log.pra      ?? 0))
        accum.min.push(Number(log.minutes  ?? 0))
      }

      const row = buildRow(playerArg, accum, now, season)
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
        .select('player_name, nba_id, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
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

    // Aggregate per player. Key by nba_id: the same player can appear under two
    // spellings (e.g. "Nikola Jokic" / "Nikola Jokić"), and (nba_id, season) is the
    // upsert key — two rows with one nba_id makes Postgres reject the whole batch.
    const playerMap = new Map<string, PlayerAccum & { names: Map<string, number> }>()

    for (const log of logs) {
      const name = log.player_name as string
      if (!name) continue
      const key = log.nba_id != null ? String(log.nba_id) : `local_${name}`
      if (!playerMap.has(key)) {
        playerMap.set(key, {
          nba_id: log.nba_id != null ? String(log.nba_id) : null,
          names: new Map(),
          pts: [], reb: [], ast: [], stl: [], blk: [], fg3m: [], pra: [], min: [],
        })
      }
      const p = playerMap.get(key)!
      p.names.set(name, (p.names.get(name) ?? 0) + 1)
      p.pts.push(Number(log.points   ?? 0))
      p.reb.push(Number(log.rebounds ?? 0))
      p.ast.push(Number(log.assists  ?? 0))
      p.stl.push(Number(log.steals   ?? 0))
      p.blk.push(Number(log.blocks   ?? 0))
      p.fg3m.push(Number(log.fg3m    ?? 0))
      p.pra.push(Number(log.pra      ?? 0))
      p.min.push(Number(log.minutes  ?? 0))
    }

    const rows = []
    for (const d of playerMap.values()) {
      // Most-used spelling wins (game logs are normalized to odds-api names going forward).
      const player_name = [...d.names.entries()].sort((a, b) => b[1] - a[1])[0][0]
      const row = buildRow(player_name, d, now, season)
      if (row) rows.push(row)
    }

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
