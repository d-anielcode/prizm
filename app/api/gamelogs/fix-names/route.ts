// /api/gamelogs/fix-names — Fix historical player_game_logs rows stored under ESPN displayNames
//
// When player-aliases.ts is updated, rows already in the DB keep the old ESPN name.
// The unique constraint on (nba_id, game_date) then silently blocks backfill inserts
// for the correct Odds-API name, leaving players with no game-log data.
//
// This endpoint walks the ESPN_TO_ODDS alias map and renames any rows stored under
// the ESPN name to the Odds-API name, so the enrich join works correctly.
//
// It also applies CORRECTIONS — cases where a wrong alias was previously applied
// and the DB needs to be reverted to the correct name.
//
// GET /api/gamelogs/fix-names          — dry run (shows what would change)
// GET /api/gamelogs/fix-names?apply=1  — apply the updates

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireCronAuth } from '@/lib/api-auth'
import { ESPN_TO_ODDS } from '@/lib/player-aliases'

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } },
  )
}

export const maxDuration = 60

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url   = new URL(req.url)
  const apply = url.searchParams.get('apply') === '1'
  const db    = getDb()

  // Corrections: cases where a wrong alias was applied and needs to be reverted.
  // Key = the wrong name now in the DB, value = the correct name to restore.
  const CORRECTIONS: Record<string, string> = {
    'Wendell Carter Jr': 'Wendell Carter Jr.',  // alias was wrong — both ESPN and Odds API use period
  }

  const results: Array<{ espn: string; odds: string; rows: number; updated: number; skipped: string }> = []
  let totalUpdated = 0

  // Apply corrections first
  for (const [wrongName, correctName] of Object.entries(CORRECTIONS)) {
    const { count } = await db
      .from('player_game_logs')
      .select('*', { count: 'exact', head: true })
      .eq('player_name', wrongName)

    const rowCount = count ?? 0
    if (rowCount === 0) {
      results.push({ espn: wrongName, odds: correctName, rows: 0, updated: 0, skipped: 'no rows (correction)' })
      continue
    }

    if (!apply) {
      results.push({ espn: wrongName, odds: correctName, rows: rowCount, updated: 0, skipped: 'dry run (correction)' })
      continue
    }

    const { error } = await db
      .from('player_game_logs')
      .update({ player_name: correctName })
      .eq('player_name', wrongName)

    if (error) {
      results.push({ espn: wrongName, odds: correctName, rows: rowCount, updated: 0, skipped: `correction error: ${error.message}` })
    } else {
      results.push({ espn: wrongName, odds: correctName, rows: rowCount, updated: rowCount, skipped: '' })
      totalUpdated += rowCount
    }
  }

  for (const [espnName, oddsName] of Object.entries(ESPN_TO_ODDS)) {
    // Skip no-ops (some aliases map to same name)
    if (espnName === oddsName) continue

    // Count rows stored under the ESPN name
    const { count } = await db
      .from('player_game_logs')
      .select('*', { count: 'exact', head: true })
      .eq('player_name', espnName)

    const rowCount = count ?? 0

    if (rowCount === 0) {
      results.push({ espn: espnName, odds: oddsName, rows: 0, updated: 0, skipped: 'no rows' })
      continue
    }

    if (!apply) {
      results.push({ espn: espnName, odds: oddsName, rows: rowCount, updated: 0, skipped: 'dry run' })
      continue
    }

    // Apply the rename
    const { error, count: updatedCount } = await db
      .from('player_game_logs')
      .update({ player_name: oddsName })
      .eq('player_name', espnName)

    if (error) {
      results.push({ espn: espnName, odds: oddsName, rows: rowCount, updated: 0, skipped: error.message })
    } else {
      const updated = updatedCount ?? rowCount
      results.push({ espn: espnName, odds: oddsName, rows: rowCount, updated, skipped: '' })
      totalUpdated += updated
    }
  }

  const needsFix = results.filter((r) => r.rows > 0 && r.skipped !== 'no rows')

  return NextResponse.json({
    apply,
    message: apply
      ? `Updated ${totalUpdated} rows across ${needsFix.length} player(s)`
      : `Dry run — ${needsFix.filter(r => r.skipped === 'dry run').length} player(s) have rows stored under ESPN names. Re-run with ?apply=1 to fix.`,
    total_updated: totalUpdated,
    aliases_checked: Object.keys(ESPN_TO_ODDS).length,
    results: results.filter((r) => r.rows > 0 || r.skipped === ''),
  })
}
