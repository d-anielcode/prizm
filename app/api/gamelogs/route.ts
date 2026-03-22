// /api/gamelogs — Fetch completed NBA box scores from ESPN and upsert to player_game_logs
// Called automatically by cron at 12:10 AM EDT before nightly grading.
// Also callable manually: GET /api/gamelogs?date=2026-03-20

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchGameLogsFromESPN } from '@/lib/espn-gamelogs'

export const maxDuration = 120

export async function GET(req: Request) {
  const url = new URL(req.url)

  // Default: yesterday in Eastern time (cron runs after midnight)
  let targetDate = url.searchParams.get('date')
  if (!targetDate) {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000)
    targetDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  }

  try {
    const { rows, games, total } = await fetchGameLogsFromESPN(targetDate)

    if (rows.length === 0) {
      return NextResponse.json({
        message: total === 0
          ? `No NBA games scheduled for ${targetDate}`
          : games === 0
            ? `No completed games yet for ${targetDate} (${total} scheduled)`
            : `Box scores not yet available for ${targetDate}`,
        date: targetDate,
        games,
        scheduled: total,
      })
    }

    // Upsert to player_game_logs (requires UNIQUE constraint on player_name, game_date)
    const BATCH = 200
    let upserted = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const { error } = await supabase
        .from('player_game_logs')
        .upsert(slice, { onConflict: 'player_name,game_date' })
      if (!error) upserted += slice.length
      else console.error('[/api/gamelogs] upsert error:', error.message)
    }

    return NextResponse.json({
      message: `Fetched ${games} game(s) — upserted ${upserted} player rows for ${targetDate}`,
      date: targetDate,
      games,
      players: upserted,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/gamelogs]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
