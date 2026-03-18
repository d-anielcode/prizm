// NBA Stats API (unofficial) — free, no API key required
// Server-side only: NBA.com blocks browser requests (CORS).
// Requires specific headers to avoid 403.

import type { BDLPlayer, BDLStatEntry, BDLSeasonAverage, PlayerStat } from '@/types'

const NBA_BASE = 'https://stats.nba.com/stats'

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.nba.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'Origin': 'https://www.nba.com',
}

// Helper: current NBA season string e.g. "2025-26"
export function getCurrentSeason(): string {
  const year = new Date().getMonth() >= 9 ? new Date().getFullYear() : new Date().getFullYear() - 1
  return `${year}-${String(year + 1).slice(2)}`
}

// Helper: parse NBA.com resultSet by name into array of row objects
type ResultSet = { name: string; headers: string[]; rowSet: unknown[][] }
function parseResultSet(resultSets: ResultSet[], name: string): Record<string, unknown>[] {
  const rs = resultSets.find((r) => r.name === name)
  if (!rs || !rs.rowSet.length) return []
  return rs.rowSet.map((row) =>
    Object.fromEntries(rs.headers.map((h, i) => [h, row[i]]))
  )
}

// In-memory player list cache (reset on server restart — that's fine, 24h revalidate handles CDN)
let _playerCache: Record<string, unknown>[] | null = null

async function getAllPlayers(): Promise<Record<string, unknown>[]> {
  if (_playerCache) return _playerCache
  const res = await fetch(
    `${NBA_BASE}/commonallplayers?LeagueID=00&Season=${getCurrentSeason()}&IsOnlyCurrentSeason=1`,
    { headers: NBA_HEADERS, next: { revalidate: 86400 } }
  )
  if (!res.ok) return []
  const data = await res.json() as { resultSets: ResultSet[] }
  _playerCache = parseResultSet(data.resultSets, 'CommonAllPlayers')
  return _playerCache
}

// Normalize a name for comparison: lowercase, strip punctuation
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z\s]/g, '').trim()
}

// Search for a player by name — returns first match
export async function searchPlayer(name: string): Promise<BDLPlayer | null> {
  try {
    const players = await getAllPlayers()
    const query = normalizeName(name)

    // Try exact match first, then partial
    const match = players.find((p) => normalizeName(p['DISPLAY_FIRST_LAST'] as string) === query)
      ?? players.find((p) => {
        const n = normalizeName(p['DISPLAY_FIRST_LAST'] as string)
        const queryWords = query.split(' ')
        return queryWords.every((w) => n.includes(w))
      })

    if (!match) return null

    const fullName = (match['DISPLAY_FIRST_LAST'] as string).trim()
    const spaceIdx = fullName.indexOf(' ')

    return {
      id: match['PERSON_ID'] as number,
      first_name: spaceIdx > -1 ? fullName.slice(0, spaceIdx) : fullName,
      last_name: spaceIdx > -1 ? fullName.slice(spaceIdx + 1) : '',
      team: {
        abbreviation: (match['TEAM_ABBREVIATION'] as string) || 'UNK',
        full_name: `${match['TEAM_CITY'] ?? ''} ${match['TEAM_NAME'] ?? ''}`.trim(),
      },
    }
  } catch {
    return null
  }
}

// Fetch last N game stats for a player (current season)
export async function fetchPlayerRecentStats(
  playerId: number,
  limit = 10
): Promise<BDLStatEntry[]> {
  const res = await fetch(
    `${NBA_BASE}/playergamelog?PlayerID=${playerId}&Season=${getCurrentSeason()}&SeasonType=Regular%20Season`,
    { headers: NBA_HEADERS, next: { revalidate: 3600 } }
  )
  if (!res.ok) throw new Error(`NBA game log failed for player ${playerId}: ${res.status}`)

  const data = await res.json() as { resultSets: ResultSet[] }
  const rows = parseResultSet(data.resultSets, 'PlayerGameLog').slice(0, limit)

  return rows.map((row, idx) => ({
    id: idx,
    date: row['GAME_DATE'] as string,
    season: new Date().getFullYear(),
    player: {
      id: playerId,
      first_name: '',
      last_name: '',
      team: { abbreviation: '', full_name: '' },
    },
    team: { abbreviation: String(row['MATCHUP'] ?? '').split(' ')[0] },
    pts: (row['PTS'] as number) ?? null,
    reb: (row['REB'] as number) ?? null,
    ast: (row['AST'] as number) ?? null,
    stl: (row['STL'] as number) ?? null,
    blk: (row['BLK'] as number) ?? null,
    fg3m: (row['FG3M'] as number) ?? null,
    min: String(row['MIN'] ?? ''),
  }))
}

// Fetch season averages for a player
export async function fetchSeasonAverages(playerId: number): Promise<BDLSeasonAverage | null> {
  try {
    const res = await fetch(
      `${NBA_BASE}/playercareerstats?PlayerID=${playerId}&PerMode=PerGame`,
      { headers: NBA_HEADERS, next: { revalidate: 3600 } }
    )
    if (!res.ok) return null

    const data = await res.json() as { resultSets: ResultSet[] }
    const rows = parseResultSet(data.resultSets, 'SeasonTotalsRegularSeason')
    // Last row = most recent season
    const current = rows[rows.length - 1]
    if (!current) return null

    return {
      player_id: playerId,
      season: new Date().getFullYear(),
      pts: (current['PTS'] as number) ?? 0,
      reb: (current['REB'] as number) ?? 0,
      ast: (current['AST'] as number) ?? 0,
      stl: (current['STL'] as number) ?? 0,
      blk: (current['BLK'] as number) ?? 0,
      fg3m: (current['FG3M'] as number) ?? 0,
      min: String(current['MIN'] ?? '0'),
    }
  } catch {
    return null
  }
}

// Convert stat entries to our PlayerStat format
export function parseBDLStats(entries: BDLStatEntry[]): PlayerStat[] {
  return entries.map((entry) => ({
    player_id: entry.player.id,
    player_name: `${entry.player.first_name} ${entry.player.last_name}`.trim(),
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

function parseMinutes(min: string | null): number {
  if (!min) return 0
  const parts = min.split(':')
  return parts.length === 2
    ? parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60
    : parseFloat(min) || 0
}
