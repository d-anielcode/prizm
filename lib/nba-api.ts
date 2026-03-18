// BallDontLie API — fetches NBA player stats
// Free tier: 60 requests/minute. Batch requests and cache results.

import type { BDLPlayer, BDLStatEntry, BDLSeasonAverage, PlayerStat } from '@/types'

const BASE_URL = 'https://api.balldontlie.io/v1'
const API_KEY = process.env.BALLDONTLIE_API_KEY!

const headers = { Authorization: API_KEY }

// Search for a player by name — returns first match
export async function searchPlayer(name: string): Promise<BDLPlayer | null> {
  const encoded = encodeURIComponent(name)
  const url = `${BASE_URL}/players?search=${encoded}&per_page=5`
  const res = await fetch(url, { headers, next: { revalidate: 86400 } }) // cache 24h
  if (!res.ok) return null

  const data = (await res.json()) as { data: BDLPlayer[] }
  return data.data[0] ?? null
}

// Fetch last N game stats for a player (current season)
export async function fetchPlayerRecentStats(
  playerId: number,
  limit = 10
): Promise<BDLStatEntry[]> {
  const season = getCurrentSeason()
  const url = `${BASE_URL}/stats?player_ids[]=${playerId}&seasons[]=${season}&per_page=${limit}&sort=date&direction=desc`
  const res = await fetch(url, { headers, next: { revalidate: 3600 } })
  if (!res.ok) throw new Error(`BallDontLie stats failed for player ${playerId}: ${res.status}`)

  const data = (await res.json()) as { data: BDLStatEntry[] }
  return data.data
}

// Fetch season averages for a player
export async function fetchSeasonAverages(playerId: number): Promise<BDLSeasonAverage | null> {
  const season = getCurrentSeason()
  const url = `${BASE_URL}/season_averages?season=${season}&player_ids[]=${playerId}`
  const res = await fetch(url, { headers, next: { revalidate: 3600 } })
  if (!res.ok) return null

  const data = (await res.json()) as { data: BDLSeasonAverage[] }
  return data.data[0] ?? null
}

// Convert BDL stat entries to our PlayerStat format
export function parseBDLStats(entries: BDLStatEntry[]): PlayerStat[] {
  return entries.map((entry) => ({
    player_id: entry.player.id,
    player_name: `${entry.player.first_name} ${entry.player.last_name}`,
    team: entry.team.abbreviation,
    game_date: entry.date,
    points: entry.pts ?? 0,
    rebounds: entry.reb ?? 0,
    assists: entry.ast ?? 0,
    steals: entry.stl ?? 0,
    blocks: entry.blk ?? 0,
    three_pointers: entry.fg3m ?? 0,
    minutes_played: parseMinutes(entry.min),
    cached_at: new Date().toISOString(),
  }))
}

// Helper: parse "MM:SS" or "MM" minutes string into decimal
function parseMinutes(min: string | null): number {
  if (!min) return 0
  const parts = min.split(':')
  return parts.length === 2
    ? parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60
    : parseFloat(min) || 0
}

// Helper: return current NBA season year (season starts in Oct, ends in June)
export function getCurrentSeason(): number {
  const now = new Date()
  // NBA season spans two years; season "2024" = 2024-25
  return now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1
}
