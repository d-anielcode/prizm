// /api/gamelogs/migrate — One-time rename of old ESPN ASCII names to correct Odds-API names
//
// Iterates ESPN_TO_ODDS aliases and renames any existing game log rows so
// player_game_logs.player_name matches what the props table stores.
//
// Safe to run multiple times — rows that already have the correct name are skipped.
//
// GET /api/gamelogs/migrate

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ESPN_TO_ODDS } from '@/lib/player-aliases'

export const maxDuration = 60

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Reverse any previously-wrong renames that used bad alias targets.
// Run once after a bad migration; safe to re-run (no-ops when rows don't exist).
const REVERSE_RENAMES: [string, string][] = [
  ['G.G. Jackson',   'GG Jackson II'],   // was wrong alias target
  ['C.J. McCollum',  'CJ McCollum'],     // was wrong alias target
  ['Derrick Jones',  'Derrick Jones Jr.'], // was wrong alias target
  ['Jabari Smith Jr', 'Jabari Smith Jr.'], // stripped period incorrectly
  ['Jaime Jaquez Jr', 'Jaime Jaquez Jr.'], // stripped period incorrectly
]

export async function GET() {
  const db = getDb()

  // Build a deduplicated list of (espnName → oddsName) pairs where they differ
  const renames = Object.entries(ESPN_TO_ODDS)
    .filter(([espn, odds]) => espn !== odds)

  const results: { from: string; to: string; updated: number }[] = []

  // Run reverse renames first (fix previously bad renames)
  for (const [from, to] of REVERSE_RENAMES) {
    const { data, error } = await db
      .from('player_game_logs')
      .update({ player_name: to })
      .eq('player_name', from)
      .select('player_name')
    if (error) console.error(`[migrate] reverse "${from}" → "${to}": ${error.message}`)
    else if ((data?.length ?? 0) > 0) results.push({ from, to, updated: data!.length })
  }

  for (const [espnName, oddsName] of renames) {
    const { data, error } = await db
      .from('player_game_logs')
      .update({ player_name: oddsName })
      .eq('player_name', espnName)
      .select('player_name')

    if (error) {
      console.error(`[migrate] rename "${espnName}" → "${oddsName}": ${error.message}`)
      results.push({ from: espnName, to: oddsName, updated: -1 })
    } else {
      const n = data?.length ?? 0
      if (n > 0) results.push({ from: espnName, to: oddsName, updated: n })
    }
  }

  const totalUpdated = results.reduce((s, r) => s + Math.max(r.updated, 0), 0)

  return NextResponse.json({
    message: `Migration complete — ${totalUpdated} rows renamed across ${results.filter(r => r.updated > 0).length} players`,
    totalUpdated,
    renames: results.filter(r => r.updated > 0),
  })
}
