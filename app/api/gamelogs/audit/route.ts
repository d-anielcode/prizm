// /api/gamelogs/audit — Cross-references active prop players against player_game_logs
//
// Returns players who have recent props but no game logs in the last 14 days.
// These are almost always name mismatches between ESPN and The Odds API.
//
// GET /api/gamelogs/audit?days=14   — look-back window (default 14)

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const maxDuration = 60

export async function GET(req: Request) {
  const url  = new URL(req.url)
  const days = parseInt(url.searchParams.get('days') ?? '14')

  const cutoff = new Date(Date.now() - days * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // 1. All distinct players with props in the window
  const { data: propRows } = await supabase
    .from('props')
    .select('player_name')
    .gte('commence_time', new Date(Date.now() - days * 86400000).toISOString())

  const propPlayers = new Set((propRows ?? []).map((r) => r.player_name as string))

  // 2. All distinct players with game logs in the window
  const { data: logRows } = await supabase
    .from('player_game_logs')
    .select('player_name')
    .gte('game_date', cutoff)

  const logPlayers = new Set((logRows ?? []).map((r) => r.player_name as string))

  // 3. Players with props but NO game logs → likely name mismatch
  const missing = [...propPlayers]
    .filter((p) => !logPlayers.has(p))
    .sort()

  // 4. Players with game logs but NO props → benign (backups, players who got cut, etc.)
  const logOnly = [...logPlayers]
    .filter((p) => !propPlayers.has(p))
    .sort()

  return NextResponse.json({
    window_days:     days,
    cutoff,
    prop_players:    propPlayers.size,
    log_players:     logPlayers.size,
    missing_logs:    missing.length,
    missing:         missing,          // ← fix these in player-aliases.ts
    log_only_count:  logOnly.length,   // informational only
    message: missing.length === 0
      ? 'All prop players have game logs — no name mismatches detected'
      : `${missing.length} player(s) have props but no game logs. Add them to player-aliases.ts if ESPN uses a different name.`,
  })
}
