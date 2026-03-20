// /api/gamelogs/backfill — Backfill NBA game logs for a date range
//
// Usage:
//   GET /api/gamelogs/backfill
//     → processes up to `limit` days starting from `start` (default: season start)
//
// Params:
//   start  — first date to process  (default: 2025-10-22, NBA season opener)
//   end    — last date to process   (default: yesterday)
//   limit  — max dates per call     (default: 7, max: 20 — keeps response under timeout)
//
// Because the full season has ~150 dates, call this in batches using the `nextUrl`
// returned in each response until `done: true`.
//
// Example workflow:
//   1. GET /api/gamelogs/backfill?limit=10            → processes Oct 22–31
//   2. GET /api/gamelogs/backfill?start=2025-11-01&limit=10  → processes Nov 1–10
//   …or just follow the `nextUrl` field each time.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchGameLogsFromESPN, dateRange } from '@/lib/espn-gamelogs'

const NBA_SEASON_START = '2025-10-22'
const BATCH_SIZE = 200

function yesterday(): string {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000)
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const start   = url.searchParams.get('start') ?? NBA_SEASON_START
  const end     = url.searchParams.get('end')   ?? yesterday()
  const limit   = Math.min(parseInt(url.searchParams.get('limit') ?? '7'), 20)

  const allDates  = dateRange(start, end)
  const batchDates = allDates.slice(0, limit)
  const nextDate   = allDates[limit] ?? null // first unprocessed date after this batch

  let totalUpserted = 0
  let totalSkipped  = 0
  let totalGames    = 0

  const results: Array<{ date: string; games: number; players: number; skipped?: boolean; error?: string }> = []

  for (const date of batchDates) {
    try {
      const { rows, games, total } = await fetchGameLogsFromESPN(date)

      if (rows.length === 0) {
        results.push({ date, games: 0, players: 0, skipped: total === 0 })
        totalSkipped++
        // Brief pause between requests to be polite to ESPN
        await new Promise((r) => setTimeout(r, 100))
        continue
      }

      totalGames += games

      let upserted = 0
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const slice = rows.slice(i, i + BATCH_SIZE)
        const { error } = await supabase
          .from('player_game_logs')
          .upsert(slice, { onConflict: 'player_name,game_date' })
        if (!error) upserted += slice.length
        else console.error(`[backfill] upsert error on ${date}:`, error.message)
      }

      totalUpserted += upserted
      results.push({ date, games, players: upserted })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error(`[backfill] error on ${date}:`, msg)
      results.push({ date, games: 0, players: 0, error: msg })
    }

    // 150ms pause between days to avoid ESPN rate limiting
    await new Promise((r) => setTimeout(r, 150))
  }

  const done = nextDate === null

  const baseUrl = url.origin
  const nextUrl = done
    ? null
    : `${baseUrl}/api/gamelogs/backfill?start=${nextDate}&end=${end}&limit=${limit}`

  console.log(
    `[backfill] Processed ${batchDates.length} dates | ${totalGames} games | ${totalUpserted} player rows upserted`,
  )

  return NextResponse.json({
    message: done
      ? `Backfill complete — processed ${batchDates.length} dates, upserted ${totalUpserted} player rows across ${totalGames} games`
      : `Processed ${batchDates.length} dates (${totalUpserted} rows). ${allDates.length - limit} dates remaining — follow nextUrl to continue.`,
    done,
    processed:      batchDates.length,
    totalGames,
    totalUpserted,
    skipped:        totalSkipped,
    next:           nextDate,
    nextUrl,
    rangeProcessed: { from: batchDates[0], to: batchDates[batchDates.length - 1] },
    remaining:      Math.max(0, allDates.length - limit),
    results,
  })
}
