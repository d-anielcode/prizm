// /api/player-positions — Fetch real NBA player positions and upsert to player_positions table.
// Called daily after /api/defense-stats so the enrich route uses accurate positions
// instead of the stat-based heuristic (inferPlayerPosition).
//
// Source: stats.nba.com/stats/leaguedashplayerbiostats
// Position mapping: G/G-F/F-G → guard | F/F-C/F-G → forward | C/C-F → center

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireCronAuth } from '@/lib/api-auth'
import { CURRENT_SEASON } from '@/lib/constants'

export const maxDuration = 60

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
}

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } },
  )
}

/** Map raw NBA position string → position group */
function mapPosition(raw: string): 'guard' | 'forward' | 'center' {
  const p = (raw ?? '').trim().toUpperCase()
  if (p === 'C' || p === 'C-F') return 'center'
  if (p === 'G' || p === 'G-F' || p === 'F-G') return 'guard'
  return 'forward'  // F, F-C, unknown
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const db = getDb()
  const now = new Date().toISOString()

  // Build URL with all required params for leaguedashplayerbiostats
  const params: Record<string, string | number> = {
    LeagueID: '00', Season: CURRENT_SEASON, SeasonType: 'Regular Season',
    PerMode: 'PerGame', College: '', Conference: '', Country: '', DateFrom: '',
    DateTo: '', Division: '', DraftPick: '', DraftYear: '', GameScope: '',
    GameSegment: '', Height: '', LastNGames: 0, Location: '', Month: 0,
    OpponentTeamID: 0, Outcome: '', PORound: 0, Period: 0,
    PlayerExperience: '', PlayerPosition: '', SeasonSegment: '',
    ShotClockRange: '', StarterBench: '', TeamID: 0, VsConference: '',
    VsDivision: '', Weight: '',
  }
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  const url = `https://stats.nba.com/stats/leaguedashplayerbiostats?${qs}`

  console.log('[player-positions] Fetching player bio stats from NBA API...')
  const res = await fetch(url, { headers: NBA_HEADERS, cache: 'no-store' })
  if (!res.ok) {
    console.error(`[player-positions] NBA API error: ${res.status}`)
    return NextResponse.json({ error: `NBA API returned ${res.status}` }, { status: 502 })
  }

  const json = await res.json()
  const set = json?.resultSets?.[0]
  if (!set?.headers || !set?.rowSet) {
    return NextResponse.json({ error: 'Unexpected NBA API response shape' }, { status: 502 })
  }

  const headers: string[] = set.headers
  const rows: unknown[][] = set.rowSet
  const nameIdx = headers.indexOf('PLAYER_NAME')
  const posIdx  = headers.indexOf('PLAYER_POSITION')

  if (nameIdx < 0 || posIdx < 0) {
    return NextResponse.json(
      { error: 'PLAYER_NAME or PLAYER_POSITION column missing', headers },
      { status: 502 },
    )
  }

  const posRows = rows
    .filter(row => row[nameIdx] && row[posIdx])
    .map(row => ({
      player_name:    String(row[nameIdx]),
      nba_position:   String(row[posIdx]),
      position_group: mapPosition(String(row[posIdx])),
      updated_at:     now,
    }))

  console.log(`[player-positions] ${posRows.length} players parsed, upserting...`)

  // Upsert in batches of 500
  let upserted = 0
  for (let i = 0; i < posRows.length; i += 500) {
    const chunk = posRows.slice(i, i + 500)
    const { error } = await db
      .from('player_positions')
      .upsert(chunk, { onConflict: 'player_name' })
    if (error) {
      console.error('[player-positions] upsert error:', error.message)
    } else {
      upserted += chunk.length
    }
  }

  console.log(`[player-positions] Done — ${upserted} player positions saved`)

  // Sample a few for verification
  const sample = posRows.slice(0, 5).map(r => `${r.player_name} (${r.nba_position} → ${r.position_group})`)

  return NextResponse.json({
    ok: true,
    total: posRows.length,
    upserted,
    sample,
    message: `${upserted} player positions updated`,
  })
}
