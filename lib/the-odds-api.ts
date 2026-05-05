// The Odds API (the-odds-api.com) — historical player prop lines
//
// Used exclusively for historical backfill of actual prop lines.
// Live props continue to come from odds-api.io (free tier, sufficient for DK+FD).
//
// Cost: 10 requests per market per event per call.
// For 7 markets per event: 70 requests/event.
// 45-day backfill estimate: ~18,900 requests.

const BASE = 'https://api.the-odds-api.com/v4'
// Deferred env-var check — module-init throws break Next 16 build-time
// page-data collection on Vercel (build env doesn't have runtime secrets).
function apiKey(): string {
  const k = process.env.ODDS_API_KEY
  if (!k) throw new Error('Missing ODDS_API_KEY environment variable')
  return k
}

// Markets we track — matches our StatType enum
const MARKETS = [
  'player_points',
  'player_rebounds',
  'player_assists',
  'player_threes',
  'player_steals',
  'player_blocks',
  'player_points_rebounds_assists',
].join(',')

const MARKET_TO_STAT: Record<string, string> = {
  player_points:                    'points',
  player_rebounds:                  'rebounds',
  player_assists:                   'assists',
  player_threes:                    'three_pointers',
  player_steals:                    'steals',
  player_blocks:                    'blocks',
  player_points_rebounds_assists:   'pra',
}

export interface HistoricalPropLine {
  game_date:     string   // YYYY-MM-DD (Eastern)
  game_id:       string
  player_name:   string
  stat_type:     string
  direction:     'over' | 'under'
  line:          number
  odds:          number | null
  sportsbook:    string
  home_team:     string
  away_team:     string
  commence_time: string
}

/** Convert UTC ISO string to Eastern YYYY-MM-DD */
function toEasternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/** Fetch all NBA event IDs for a given snapshot date (1 request) */
export async function fetchHistoricalEventIds(
  snapshotDate: string, // ISO 8601 UTC, e.g. "2026-03-20T23:00:00Z"
): Promise<Array<{ id: string; home_team: string; away_team: string; commence_time: string }>> {
  const url = `${BASE}/historical/sports/basketball_nba/events?apiKey=${apiKey()}&date=${encodeURIComponent(snapshotDate)}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    console.error(`[the-odds-api] historical events failed: ${res.status}`)
    return []
  }
  const data = await res.json() as { data?: Array<{ id: string; home_team: string; away_team: string; commence_time: string }> }
  return data.data ?? []
}

/** Fetch historical prop lines for a single event (70 requests — 7 markets × 10) */
export async function fetchHistoricalEventProps(
  eventId:      string,
  snapshotDate: string,  // ISO 8601 UTC
  homeTeam:     string,
  awayTeam:     string,
  commenceTime: string,
): Promise<HistoricalPropLine[]> {
  const gameDate = toEasternDate(commenceTime)

  const url =
    `${BASE}/historical/sports/basketball_nba/events/${eventId}/odds` +
    `?apiKey=${apiKey()}&date=${encodeURIComponent(snapshotDate)}` +
    `&markets=${MARKETS}&regions=us&oddsFormat=american` +
    `&bookmakers=draftkings,fanduel,williamhill_us,fanatics`

  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    console.error(`[the-odds-api] historical event odds failed: ${res.status} for event ${eventId}`)
    return []
  }

  const data  = await res.json() as { data?: { bookmakers?: Array<{ key: string; markets?: Array<{ key: string; outcomes?: Array<{ name: string; description: string; point: number; price: number }> }> }> } }
  const event = data.data
  if (!event) return []

  const lines: HistoricalPropLine[] = []

  for (const book of event.bookmakers ?? []) {
    for (const market of book.markets ?? []) {
      const statType = MARKET_TO_STAT[market.key]
      if (!statType) continue

      // Deduplicate by player — some books list Over + Under as separate outcomes
      const playerLines = new Map<string, { over?: number; overOdds?: number; under?: number; underOdds?: number }>()

      for (const outcome of market.outcomes ?? []) {
        const player = outcome.description?.trim()
        if (!player || outcome.point == null) continue
        if (!playerLines.has(player)) playerLines.set(player, {})
        const entry = playerLines.get(player)!
        if (outcome.name === 'Over') {
          entry.over      = outcome.point
          entry.overOdds  = outcome.price
        } else if (outcome.name === 'Under') {
          entry.under     = outcome.point
          entry.underOdds = outcome.price
        }
      }

      for (const [playerName, pl] of playerLines) {
        const line = pl.over ?? pl.under
        if (line == null) continue

        if (pl.over != null) {
          lines.push({
            game_date:     gameDate,
            game_id:       eventId,
            player_name:   playerName,
            stat_type:     statType,
            direction:     'over',
            line,
            odds:          pl.overOdds ?? null,
            sportsbook:    book.key,
            home_team:     homeTeam,
            away_team:     awayTeam,
            commence_time: commenceTime,
          })
        }
        if (pl.under != null) {
          lines.push({
            game_date:     gameDate,
            game_id:       eventId,
            player_name:   playerName,
            stat_type:     statType,
            direction:     'under',
            line:          pl.under,
            odds:          pl.underOdds ?? null,
            sportsbook:    book.key,
            home_team:     homeTeam,
            away_team:     awayTeam,
            commence_time: commenceTime,
          })
        }
      }
    }
  }

  return lines
}
