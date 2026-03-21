// /api/prophistory/backfill
//
// Fetches historical player prop lines from The Odds API and stores them in
// historical_prop_lines. Designed to be called in small batches to stay within
// the 70 req/event API cost (7 markets × 10 per market).
//
// GET ?start=YYYY-MM-DD&end=YYYY-MM-DD&limit=N (default limit=3 days per call)
//   → processes [limit] days, returns { done, next, totalUpserted, datesProcessed, requestsNote }
//
// Recommended usage: call repeatedly with ?start=<next> until done=true.
// Estimated cost: ~70 requests/event × ~6 events/day × limit days

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { fetchHistoricalEventIds, fetchHistoricalEventProps, type HistoricalPropLine } from '@/lib/the-odds-api'
import { dateRange } from '@/lib/espn-gamelogs'

export const maxDuration = 60

export async function GET(req: Request) {
  const url    = new URL(req.url)
  const defaultStart = new Date(Date.now() - 45 * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const defaultEnd = new Date(Date.now() - 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const start  = url.searchParams.get('start') ?? defaultStart
  const end    = url.searchParams.get('end')   ?? defaultEnd
  const limit  = Math.min(parseInt(url.searchParams.get('limit') ?? '3'), 7)

  const allDates  = dateRange(start, end)
  const batch     = allDates.slice(0, limit)
  const remaining = allDates.slice(limit)

  if (batch.length === 0) {
    return NextResponse.json({ done: true, message: 'No dates to process', totalUpserted: 0 })
  }

  let totalUpserted = 0
  const datesProcessed: string[] = []

  for (const date of batch) {
    // Use 23:00 UTC snapshot (7 PM ET) — captures pre-game lines for most NBA tipoffs
    const snapshot = `${date}T23:00:00Z`

    const events = await fetchHistoricalEventIds(snapshot)
    if (events.length === 0) {
      datesProcessed.push(`${date} (0 events)`)
      continue
    }

    const allLines: HistoricalPropLine[] = []

    for (const event of events) {
      // Use the same day snapshot (23:00 UTC ≈ 7 PM ET) for all events.
      // Props are typically posted by early evening; computing per-event snapshots
      // (e.g. commence_time - 2h) puts us too early before books post lines.
      const lines = await fetchHistoricalEventProps(
        event.id,
        snapshot,
        event.home_team,
        event.away_team,
        event.commence_time,
      )
      allLines.push(...lines)
    }

    if (allLines.length > 0) {
      const BATCH = 500
      for (let i = 0; i < allLines.length; i += BATCH) {
        const { error } = await supabase
          .from('historical_prop_lines')
          .upsert(allLines.slice(i, i + BATCH), { onConflict: 'game_date,player_name,stat_type,direction,sportsbook' })
        if (error) console.error(`[prophistory/backfill] upsert error: ${error.message}`)
        else totalUpserted += allLines.slice(i, i + BATCH).length
      }
      datesProcessed.push(`${date} (${events.length} games, ${allLines.length} lines)`)
    } else {
      datesProcessed.push(`${date} (${events.length} games, 0 lines)`)
    }
  }

  const done = remaining.length === 0
  const next = done ? null : remaining[0]

  return NextResponse.json({
    done,
    next,
    totalUpserted,
    datesProcessed,
    remainingDays: remaining.length,
    requestsNote: `~${batch.length * 6 * 70} requests used this batch (est.)`,
  })
}
