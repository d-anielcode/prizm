// NBA Stats — BallDontLie API (free tier)
// Free tier: 60 req/min. Strategy:
//   1. Search players one-at-a-time with 150ms gaps (sequential, not concurrent)
//   2. Batch ALL season averages in a single request
//   3. Cache player name→id in memory so searches only happen once per server session

import type { BDLPlayer, BDLSeasonAverage, StatType } from '@/types'

const BDL_BASE = 'https://api.balldontlie.io/v1'
const BDL_KEY  = process.env.BALLDONTLIE_API_KEY ?? ''

const BDL_HEADERS = { Authorization: BDL_KEY }

// In-memory player name → BDL id cache (reset on server restart — fine, 24h revalidate)
const _playerIdCache = new Map<string, number | null>() // null = "not found"

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, '').trim()
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Search for one player by display name, returning their BDL numeric id.
// Uses in-memory cache to avoid repeat lookups.
async function resolvePlayerId(name: string): Promise<number | null> {
  const key = normalizeName(name)
  if (_playerIdCache.has(key)) return _playerIdCache.get(key) ?? null

  try {
    // Search by last name (most unique fragment)
    const lastName = name.split(' ').pop() ?? name
    const url = `${BDL_BASE}/players?search=${encodeURIComponent(lastName)}&per_page=25`
    const res = await fetch(url, { headers: BDL_HEADERS })

    if (res.status === 429) {
      console.warn('[BDL] rate limited during player search — skipping', name)
      _playerIdCache.set(key, null)
      return null
    }
    if (!res.ok) {
      _playerIdCache.set(key, null)
      return null
    }

    const data = await res.json() as { data: BDLPlayer[] }
    const players = data.data ?? []

    const match =
      players.find((p) => normalizeName(`${p.first_name} ${p.last_name}`) === key) ??
      players.find((p) => {
        const full = normalizeName(`${p.first_name} ${p.last_name}`)
        return key.split(' ').every((w) => full.includes(w))
      })

    const id = match?.id ?? null
    _playerIdCache.set(key, id)
    return id
  } catch {
    _playerIdCache.set(key, null)
    return null
  }
}

// Resolve a list of player names → BDL ids, sequentially with a 150ms gap
// to stay within the 60 req/min free tier limit.
export async function resolvePlayerIds(
  names: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()

  for (const name of names) {
    // Skip if already cached
    if (!_playerIdCache.has(normalizeName(name))) {
      await sleep(150)
    }
    const id = await resolvePlayerId(name)
    if (id !== null) result.set(name, id)
  }

  return result
}

// Fetch season averages for multiple players in ONE request (free tier supports this)
// Returns a map of BDL player_id → averages
export async function fetchSeasonAveragesBatch(
  playerIds: number[],
): Promise<Map<number, BDLSeasonAverage>> {
  const result = new Map<number, BDLSeasonAverage>()
  if (playerIds.length === 0) return result

  try {
    const season = getCurrentSeason()
    const idParams = playerIds.map((id) => `player_ids[]=${id}`).join('&')
    const url = `${BDL_BASE}/season_averages?season=${season}&${idParams}`
    const res = await fetch(url, {
      headers: BDL_HEADERS,
      next: { revalidate: 3600 },
    })

    if (res.status === 429) {
      console.warn('[BDL] rate limited on season_averages batch')
      return result
    }
    if (!res.ok) {
      console.error(`[BDL] season_averages batch failed: ${res.status}`)
      return result
    }

    const data = await res.json() as {
      data: Array<{
        player_id: number; season: number
        pts: number; reb: number; ast: number
        stl: number; blk: number; fg3m: number; min: string
      }>
    }

    for (const avg of data.data ?? []) {
      result.set(avg.player_id, {
        player_id: avg.player_id,
        season: avg.season,
        pts:  avg.pts  ?? 0,
        reb:  avg.reb  ?? 0,
        ast:  avg.ast  ?? 0,
        stl:  avg.stl  ?? 0,
        blk:  avg.blk  ?? 0,
        fg3m: avg.fg3m ?? 0,
        min:  avg.min  ?? '0',
      })
    }
  } catch (err) {
    console.error('[BDL] fetchSeasonAveragesBatch error:', err)
  }

  return result
}

// Current NBA season as start year (BDL uses 2025 for the 2025-26 season)
export function getCurrentSeason(): number {
  const now = new Date()
  return now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1
}

// Map a BDLSeasonAverage → StatType keyed record for use in scoring
export function buildSeasonAvgMap(avg: BDLSeasonAverage): Record<StatType, number> {
  return {
    points:         avg.pts,
    rebounds:       avg.reb,
    assists:        avg.ast,
    steals:         avg.stl,
    blocks:         avg.blk,
    three_pointers: avg.fg3m,
    pra:            avg.pts + avg.reb + avg.ast,
  }
}
