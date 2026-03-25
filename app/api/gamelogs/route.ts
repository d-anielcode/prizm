// /api/gamelogs — Fetch completed NBA box scores from ESPN and upsert to player_game_logs
//
// GET ?date=YYYY-MM-DD   — single date (default: yesterday)
// GET ?days=N            — last N days, re-fetches all of them (default 1, max 7)
//                          Use ?days=3 in cron to self-heal missed nights

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchGameLogsFromESPN } from '@/lib/espn-gamelogs'

export const maxDuration = 120

function nDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

async function fetchAndUpsert(targetDate: string) {
  const { rows, games, total } = await fetchGameLogsFromESPN(targetDate)

  if (rows.length === 0) {
    return {
      date: targetDate,
      games: 0,
      players: 0,
      scheduled: total,
      skipped: true,
      message: total === 0
        ? `No NBA games scheduled`
        : games === 0
          ? `No completed games yet (${total} scheduled)`
          : `Box scores not yet available`,
    }
  }

  const BATCH = 200
  let upserted = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const { error } = await supabase
      .from('player_game_logs')
      .upsert(slice, { onConflict: 'player_name,game_date' })
    if (!error) upserted += slice.length
    else console.error(`[/api/gamelogs] upsert error on ${targetDate}:`, error.message)
  }

  return { date: targetDate, games, players: upserted, skipped: false }
}

export async function GET(req: Request) {
  const url = new URL(req.url)

  try {
    // Single-date mode
    if (url.searchParams.has('date')) {
      const result = await fetchAndUpsert(url.searchParams.get('date')!)
      return NextResponse.json({
        message: result.skipped
          ? `${result.date}: ${result.message}`
          : `Fetched ${result.games} game(s) — upserted ${result.players} player rows for ${result.date}`,
        ...result,
      })
    }

    // Multi-day mode (default days=1 → yesterday only, cron uses days=3)
    const days = Math.min(parseInt(url.searchParams.get('days') ?? '1'), 7)
    const dates = Array.from({ length: days }, (_, i) => nDaysAgo(i + 1))

    const results = []
    for (const date of dates) {
      results.push(await fetchAndUpsert(date))
      if (dates.length > 1) await new Promise((r) => setTimeout(r, 150))
    }

    const totalPlayers = results.reduce((s, r) => s + r.players, 0)
    const totalGames   = results.reduce((s, r) => s + r.games, 0)
    const fetched      = results.filter((r) => !r.skipped)

    return NextResponse.json({
      message: `Checked ${days} day(s) — ${fetched.length} with games, ${totalPlayers} player rows upserted`,
      days,
      totalGames,
      totalPlayers,
      results,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/gamelogs]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
