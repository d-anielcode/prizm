// The Odds API — fetches today's NBA player props
// Free tier: 500 requests/month. Cache aggressively!

import type { Prop, StatType, Direction } from '@/types'

const BASE_URL = 'https://api.the-odds-api.com/v4'
const API_KEY = process.env.ODDS_API_KEY!

// Map Odds API market keys to our StatType
const MARKET_MAP: Record<string, StatType> = {
  player_points: 'points',
  player_rebounds: 'rebounds',
  player_assists: 'assists',
  player_points_rebounds_assists: 'pra',
  player_steals: 'steals',
  player_blocks: 'blocks',
  player_threes: 'three_pointers',
}

const MARKETS = Object.keys(MARKET_MAP).join(',')

interface OddsEvent {
  id: string
  sport_key: string
  commence_time: string
  home_team: string
  away_team: string
}

interface OddsOutcome {
  name: string
  description: string
  price: number
  point: number
}

interface OddsMarket {
  key: string
  outcomes: OddsOutcome[]
}

interface OddsBookmaker {
  key: string
  markets: OddsMarket[]
}

interface OddsEventWithProps extends OddsEvent {
  bookmakers: OddsBookmaker[]
}

export async function fetchTodaysNBAEvents(): Promise<OddsEvent[]> {
  const url = `${BASE_URL}/sports/basketball_nba/events?apiKey=${API_KEY}`
  const res = await fetch(url, { next: { revalidate: 7200 } })
  if (!res.ok) throw new Error(`Odds API events failed: ${res.status}`)
  return res.json() as Promise<OddsEvent[]>
}

export async function fetchPropsForEvent(eventId: string): Promise<OddsEventWithProps> {
  const url = `${BASE_URL}/sports/basketball_nba/events/${eventId}/odds?apiKey=${API_KEY}&regions=us&markets=${MARKETS}&oddsFormat=american`
  const res = await fetch(url, { next: { revalidate: 7200 } })
  if (!res.ok) throw new Error(`Odds API props failed for ${eventId}: ${res.status}`)
  return res.json() as Promise<OddsEventWithProps>
}

export function parsePropsFromEvent(event: OddsEventWithProps): Prop[] {
  const props: Prop[] = []

  for (const bookmaker of event.bookmakers) {
    for (const market of bookmaker.markets) {
      const statType = MARKET_MAP[market.key]
      if (!statType) continue

      for (const outcome of market.outcomes) {
        if (!outcome.description || outcome.point == null) continue

        const playerName = outcome.description
        const direction: Direction = outcome.name.toLowerCase() === 'over' ? 'over' : 'under'

        // Determine team from home/away (we'll match by player name later via BallDontLie)
        props.push({
          player_id: 0, // Will be enriched via BallDontLie player search
          player_name: playerName,
          team: 'TBD',
          opponent: 'TBD',
          game_id: event.id,
          stat_type: statType,
          line: outcome.point,
          direction,
          odds: outcome.price,
          sportsbook: bookmaker.key,
          cached_at: new Date().toISOString(),
        })
      }
    }
  }

  return props
}
