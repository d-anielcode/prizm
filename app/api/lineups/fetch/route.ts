// /api/lineups/fetch
//
// Scrapes rotowire.com/basketball/nba-lineups.php (server-rendered HTML)
// and upserts each team's lineup status + starters into confirmed_lineups.
//
// Cron schedule (vercel.json):
//   16:00 UTC — early/projected lineups (lunchtime ET)
//   23:00 UTC — confirmed lineups (30 min pre-tip for 7 PM ET games)
//
// Idempotent on (game_date, team). Polite to rotowire: one URL hit per call,
// no parallelism, browser-like User-Agent.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth, internalAuthHeaders } from '@/lib/api-auth'
import { parseRotowireLineups } from '@/lib/lineups'
import { logger } from '@/lib/logger'

export const maxDuration = 60

const ROTOWIRE_URL = 'https://www.rotowire.com/basketball/nba-lineups.php'
const USER_AGENT   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function toEasternDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

async function fetchAndStore(): Promise<{
  scraped: number
  upserted: number
  errors: string[]
}> {
  const errors: string[] = []

  const res = await fetch(ROTOWIRE_URL, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
    cache:   'no-store',
  })
  if (!res.ok) {
    errors.push(`rotowire fetch ${res.status}`)
    return { scraped: 0, upserted: 0, errors }
  }

  const html  = await res.text()
  const games = parseRotowireLineups(html)
  if (games.length === 0) {
    errors.push('parsed 0 games — page structure may have changed')
    return { scraped: 0, upserted: 0, errors }
  }

  const gameDate = toEasternDate(new Date())

  // Dedup by (game_date, team) BEFORE upsert. Postgres will reject an upsert
  // where the same conflict target appears twice — "cannot affect row a second
  // time" — and the entire batch silently fails. Rotowire occasionally renders
  // the same team in two adjacent blocks (doubleheaders, parse glitches);
  // dedup here, preferring the strongest status (confirmed > expected > projected).
  const STATUS_RANK: Record<string, number> = {
    confirmed: 3, expected: 2, projected: 1, unknown: 0,
  }
  const dedupMap = new Map<string, Record<string, unknown>>()
  let duplicatesDropped = 0
  for (const g of games) {
    for (const side of [g.away, g.home]) {
      if (side.team === 'UNK' || side.starters.length === 0) continue
      const key = `${gameDate}|${side.team}`
      const existing = dedupMap.get(key)
      const row = {
        game_date:    gameDate,
        team:         side.team,
        status:       side.status,
        starters:     side.starters,
        may_not_play: side.may_not_play,
        fetched_at:   new Date().toISOString(),
      }
      if (!existing) {
        dedupMap.set(key, row)
      } else {
        duplicatesDropped++
        const newRank = STATUS_RANK[side.status] ?? 0
        const existingRank = STATUS_RANK[existing.status as string] ?? 0
        if (newRank > existingRank) dedupMap.set(key, row)
      }
    }
  }
  if (duplicatesDropped > 0) {
    errors.push(`deduped ${duplicatesDropped} duplicate (date,team) rows pre-upsert`)
  }
  const rows = [...dedupMap.values()]

  if (rows.length === 0) {
    errors.push('parsed games but produced 0 storable rows')
    return { scraped: games.length, upserted: 0, errors }
  }

  const { error } = await supabase
    .from('confirmed_lineups')
    .upsert(rows, { onConflict: 'game_date,team' })
  if (error) {
    errors.push(`upsert: ${error.message}`)
    return { scraped: games.length, upserted: 0, errors }
  }

  return { scraped: games.length, upserted: rows.length, errors }
}

/** Fire-and-forget re-enrich after a successful lineup upsert. The /api/enrich
 *  cron at 22:40 UTC is the safety net; this trigger propagates the new lineup
 *  data into scoring as soon as it lands (e.g. immediately after the 20:00 UTC
 *  lineup fetch instead of waiting 2.5h). Failures are logged but don't fail
 *  the lineup fetch — the safety cron always runs. */
async function triggerEnrichAsync(reqUrl: string): Promise<void> {
  try {
    const baseUrl = new URL(reqUrl).origin
    // Fire-and-forget: don't await; if the enrich is slow we'd block the cron
    // response past the 60s function timeout. Vercel kills the post-response
    // execution anyway, so we use the fetch API's keepalive flag.
    fetch(`${baseUrl}/api/enrich?force=true`, {
      method:  'POST',
      headers: internalAuthHeaders(),
      keepalive: true,
    }).catch((err) => {
      console.warn('[/api/lineups/fetch] enrich trigger failed (will retry on next cron)', err)
    })
  } catch (err) {
    console.warn('[/api/lineups/fetch] failed to schedule enrich trigger', err)
  }
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const result = await fetchAndStore()
    logger.info('[/api/lineups/fetch] result', result)
    // Trigger re-enrich only when we actually upserted something — no point
    // re-scoring if the scrape produced nothing new.
    if (result.upserted > 0 && result.errors.length === 0) {
      await triggerEnrichAsync(req.url)
    }
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('[/api/lineups/fetch] error', { msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return GET(req)
}
