// /api/coverage — Game log coverage check for backtest planning
//
// Cross-references every player who has appeared in historical_prop_lines against
// their earliest game_date in player_game_logs. Reports who is missing early-season
// coverage so we can target backfills before building synthetic prop lines.
//
// GET /api/coverage?target=YYYY-MM-DD
//   target — the earliest date we want coverage from (default: 2025-12-01)
//   → returns { summary, missingPlayers, coveredPlayers }

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { getEspnVariants } from '@/lib/player-aliases'

export const maxDuration = 60

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url    = new URL(req.url)
  const target = url.searchParams.get('target') ?? '2025-12-01'

  // ── 1. Load all distinct player names from historical_prop_lines ─────────────
  const propPlayers = new Set<string>()
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name')
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) propPlayers.add(row.player_name as string)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  const playerList = [...propPlayers].sort()
  console.log(`[coverage] ${playerList.length} distinct players in historical_prop_lines`)

  // Expand player names using aliases (The Odds API name → ESPN-stored variants)
  const allLookupNames = [...new Set(playerList.flatMap((p) => getEspnVariants(p)))]

  // ── 2. Load (player_name, game_date) from player_game_logs ──────────────────
  // We only need to find the EARLIEST date per player, so select just these two columns.
  const logsByPlayer = new Map<string, string>()  // player_name → earliest game_date

  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date')
        .in('player_name', allLookupNames)
        .order('game_date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) {
        const name = row.player_name as string
        const date = row.game_date as string
        if (!logsByPlayer.has(name) || date < logsByPlayer.get(name)!) {
          logsByPlayer.set(name, date)
        }
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // ── 3. Categorise each player by coverage depth ───────────────────────────────
  const SEASON_START  = '2025-10-22'
  const NOV_START     = '2025-11-01'
  const DEC_START     = '2025-12-01'
  const JAN_START     = '2026-01-01'
  const FEB_START     = '2026-02-01'

  type CoverageCategory =
    | 'full_season'   // earliest log ≤ Oct 31
    | 'nov_start'     // earliest log Nov 1–30
    | 'dec_start'     // earliest log Dec 1–31
    | 'jan_start'     // earliest log Jan 1–31
    | 'feb_start'     // earliest log Feb 1+
    | 'no_logs'       // no game logs at all

  interface PlayerCoverage {
    player:    string
    earliest:  string | null
    category:  CoverageCategory
    meetsTarget: boolean
  }

  const results: PlayerCoverage[] = []

  for (const player of playerList) {
    // Try the odds-api name AND all ESPN variants so aliases resolve correctly
    const variants = getEspnVariants(player)
    const earliest = variants.reduce<string | null>((best, v) => {
      const d = logsByPlayer.get(v) ?? null
      if (!d) return best
      if (!best || d < best) return d
      return best
    }, null)
    let category: CoverageCategory

    if (!earliest) {
      category = 'no_logs'
    } else if (earliest <= '2025-10-31') {
      category = 'full_season'
    } else if (earliest <= '2025-11-30') {
      category = 'nov_start'
    } else if (earliest <= '2025-12-31') {
      category = 'dec_start'
    } else if (earliest <= '2026-01-31') {
      category = 'jan_start'
    } else {
      category = 'feb_start'
    }

    results.push({
      player,
      earliest,
      category,
      meetsTarget: earliest != null && earliest <= target,
    })
  }

  // ── 4. Build summary ──────────────────────────────────────────────────────────
  const counts: Record<CoverageCategory, number> = {
    full_season: 0, nov_start: 0, dec_start: 0,
    jan_start: 0, feb_start: 0, no_logs: 0,
  }
  for (const r of results) counts[r.category]++

  const meetsTarget  = results.filter((r) => r.meetsTarget)
  const needsBackfill = results.filter((r) => !r.meetsTarget)

  // Among players needing backfill, find their latest available date so we know
  // how much data to fetch (or if they simply never had early-season logs)
  const noLogs          = needsBackfill.filter((r) => r.category === 'no_logs')
  const partialCoverage = needsBackfill.filter((r) => r.category !== 'no_logs')

  // ── 4b. For no-logs players, search by last name to detect name mismatches ───
  const noLogPlayers = results.filter((r) => r.category === 'no_logs').map((r) => r.player)
  const nameMismatchHints: Record<string, string[]> = {}

  if (noLogPlayers.length > 0) {
    // Extract last names to search for approximate matches
    // Handle "Jr", "Jr.", "II", "III" suffixes — use second-to-last word instead
    const SUFFIXES = new Set(['jr', 'jr.', 'ii', 'iii', 'iv', 'sr', 'sr.'])
    for (const player of noLogPlayers) {
      const parts = player.split(' ')
      const last  = parts[parts.length - 1]?.toLowerCase() ?? ''
      const lastName = (SUFFIXES.has(last) ? parts[parts.length - 2] : parts[parts.length - 1])
        ?.replace(/[^a-zA-Z]/g, '') ?? ''
      if (lastName.length < 3) continue

      const { data: matches } = await supabase
        .from('player_game_logs')
        .select('player_name')
        .ilike('player_name', `%${lastName}%`)
        .limit(5)

      if (matches && matches.length > 0) {
        const uniqueNames = [...new Set(matches.map((m) => m.player_name as string))]
        nameMismatchHints[player] = uniqueNames
      }
    }
  }

  return NextResponse.json({
    targetDate:      target,
    totalPropPlayers: playerList.length,
    summary: {
      meetsTarget:    meetsTarget.length,
      needsBackfill:  needsBackfill.length,
      noLogsAtAll:    noLogs.length,
      partialCoverage: partialCoverage.length,
      byCategory: {
        full_season:  `${counts.full_season} players (earliest log before Nov 1)`,
        nov_start:    `${counts.nov_start} players (earliest log Nov)`,
        dec_start:    `${counts.dec_start} players (earliest log Dec)`,
        jan_start:    `${counts.jan_start} players (earliest log Jan)`,
        feb_start:    `${counts.feb_start} players (earliest log Feb+)`,
        no_logs:      `${counts.no_logs} players (no game logs at all)`,
      },
    },
    // Players that need backfill to reach target date, sorted by how much is missing
    needsBackfill: needsBackfill
      .sort((a, b) => (a.earliest ?? '9999') > (b.earliest ?? '9999') ? 1 : -1)
      .map((r) => ({
        player:   r.player,
        earliest: r.earliest ?? 'none',
        category: r.category,
        // How many days of logs are missing before target
        missingDays: r.earliest
          ? Math.round((new Date(target).getTime() - new Date(r.earliest).getTime()) / 86400000)
          : null,
      })),
    // Name mismatch hints for no-logs players
    nameMismatchHints,
    // Players with full coverage (just counts, not full list)
    coveredCount: meetsTarget.length,
  })
}
