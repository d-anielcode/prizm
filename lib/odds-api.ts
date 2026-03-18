// odds-api.io — fetches NBA player props
// Free tier: 100 requests/hour
// Optimized: 1 req for events + ceil(games/10) reqs for props via /odds/multi

import type { Prop, StatType, Direction } from '@/types'

const BASE_URL = 'https://api.odds-api.io/v3'
const API_KEY = process.env.ODDS_API_IO_KEY!
const BOOKMAKERS = 'DraftKings,FanDuel'

// Map market name fragments → our StatType (order matters: longer matches first)
const MARKET_MAP: [string, StatType][] = [
  ['Points + Rebounds + Assists', 'pra'],
  ['PRA', 'pra'],
  ['Points', 'points'],
  ['Rebounds', 'rebounds'],
  ['Assists', 'assists'],
  ['Three', 'three_pointers'],
  ['Steals', 'steals'],
  ['Blocks', 'blocks'],
]

interface IOEvent {
  id: number
  home: string
  away: string
  date: string
  status: string
}

interface IOOddsEntry {
  label: string
  hdp: number
  over: string
  under: string
}

interface IOMarket {
  name: string
  odds: IOOddsEntry[]
}

interface IOEventWithOdds {
  id: number
  home: string
  away: string
  bookmakers: Record<string, IOMarket[]>
}

// Normalized event shape (used by /api/props route)
export interface NBAEvent {
  id: string
  home_team: string
  away_team: string
  commence_time: string
}

export type EventWithProps = IOEventWithOdds & { home_team: string; away_team: string }

// Step 1: Get today's pending NBA games (1 request)
export async function fetchTodaysNBAEvents(): Promise<NBAEvent[]> {
  const url = `${BASE_URL}/events?apiKey=${API_KEY}&sport=basketball&league=usa-nba&status=pending`
  const res = await fetch(url, { next: { revalidate: 3600 } })
  if (!res.ok) throw new Error(`odds-api.io events failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { data?: IOEvent[] } | IOEvent[]
  const events: IOEvent[] = Array.isArray(data) ? data : (data.data ?? [])

  return events.map((e) => ({
    id: String(e.id),
    home_team: e.home,
    away_team: e.away,
    commence_time: e.date,
  }))
}

// Step 2: Fetch props for ALL events in batches of 10 (ceil(N/10) requests)
export async function fetchAllPropsForEvents(events: NBAEvent[]): Promise<Prop[]> {
  const allProps: Prop[] = []
  const BATCH = 10

  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH)
    const ids = batch.map((e) => e.id).join(',')

    const url = `${BASE_URL}/odds/multi?apiKey=${API_KEY}&eventIds=${ids}&bookmakers=${BOOKMAKERS}`
    const res = await fetch(url, { next: { revalidate: 3600 } })
    if (!res.ok) {
      console.error(`[odds-api.io] /odds/multi failed: ${res.status} ${await res.text()}`)
      continue
    }

    const data = await res.json() as IOEventWithOdds[] | { data?: IOEventWithOdds[] }
    const eventList: IOEventWithOdds[] = Array.isArray(data) ? data : (data.data ?? [])

    for (const event of eventList) {
      const enriched: EventWithProps = { ...event, home_team: event.home, away_team: event.away }
      allProps.push(...parsePropsFromEvent(enriched))
    }
  }

  return allProps
}

// Legacy single-event fetch (kept for compatibility, uses batched route internally)
export async function fetchPropsForEvent(eventId: string): Promise<EventWithProps> {
  const url = `${BASE_URL}/odds?apiKey=${API_KEY}&eventId=${eventId}&bookmakers=${BOOKMAKERS}`
  const res = await fetch(url, { next: { revalidate: 3600 } })
  if (!res.ok) throw new Error(`odds-api.io props failed for ${eventId}: ${res.status}`)
  const data = await res.json() as IOEventWithOdds
  return { ...data, home_team: data.home, away_team: data.away }
}

function resolveStatType(marketName: string): StatType | null {
  for (const [fragment, stat] of MARKET_MAP) {
    if (marketName.includes(fragment)) return stat
  }
  return null
}

function decimalToAmerican(decimal: number): number {
  if (decimal >= 2) return Math.round((decimal - 1) * 100)
  return Math.round(-100 / (decimal - 1))
}

export function parsePropsFromEvent(event: EventWithProps): Prop[] {
  const props: Prop[] = []

  for (const [bookmaker, markets] of Object.entries(event.bookmakers ?? {})) {
    for (const market of markets) {
      const statType = resolveStatType(market.name)
      if (!statType) continue

      for (const entry of market.odds) {
        if (!entry.label || entry.hdp == null) continue

        const directions: Direction[] = ['over', 'under']
        for (const direction of directions) {
          const decimal = parseFloat(direction === 'over' ? entry.over : entry.under)
          props.push({
            player_id: 0,
            player_name: entry.label,
            team: 'TBD',
            opponent: 'TBD',
            game_id: String(event.id),
            stat_type: statType,
            line: entry.hdp,
            direction,
            odds: isNaN(decimal) ? undefined : decimalToAmerican(decimal),
            sportsbook: bookmaker,
            cached_at: new Date().toISOString(),
          })
        }
      }
    }
  }

  return props
}
