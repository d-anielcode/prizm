// odds-api.io — fetches NBA player props
// Free tier: 100 requests/hour
// Optimized: 1 req for events + ceil(games/10) reqs for props via /odds/multi
//
// API format: all player props live under a single "Player Props" market.
// Each entry label is "Player Name (Stat Type)", e.g. "LeBron James (Points)"

import type { Prop, StatType, Direction } from '@/types'

const BASE_URL = 'https://api.odds-api.io/v3'
const API_KEY = process.env.ODDS_API_IO_KEY
if (!API_KEY) throw new Error('Missing ODDS_API_IO_KEY environment variable')
const BOOKMAKERS = 'DraftKings,FanDuel'

// Map stat type strings in labels → our StatType
// Label format: "Player Name (Stat Type)"
const LABEL_STAT_MAP: Record<string, StatType> = {
  'Points':          'points',
  'Rebounds':        'rebounds',
  'Assists':         'assists',
  'Steals':          'steals',
  'Blocks':          'blocks',
  '3 Point FG':      'three_pointers',
  'Pts+Rebs+Asts':   'pra',
}

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
  date?: string
  bookmakers: Record<string, IOMarket[]>
}

// Normalized event shape (used by /api/props route)
export interface NBAEvent {
  id: string
  home_team: string
  away_team: string
  commence_time: string
}

export type EventWithProps = IOEventWithOdds & { home_team: string; away_team: string; commence_time?: string }

// Step 1: Get today's pending NBA games (1 request)
// The API returns all future pending events (up to 2 weeks out). We filter to
// the nearest game date only — prevents processing 100+ events across 14 days,
// which causes timeouts and incorrect line selection via cross-day dedup collisions.
export async function fetchTodaysNBAEvents(): Promise<NBAEvent[]> {
  const url = `${BASE_URL}/events?apiKey=${API_KEY}&sport=basketball&league=usa-nba&status=pending`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`odds-api.io events failed: ${res.status} ${await res.text()}`)

  const data = await res.json() as { data?: IOEvent[] } | IOEvent[]
  const events: IOEvent[] = Array.isArray(data) ? data : (data.data ?? [])

  if (events.length === 0) return []

  // Convert each event's UTC commence_time to an Eastern date and find the earliest ET date.
  // NBA games can tip after midnight UTC (e.g. 8 PM ET = 00:00 UTC next day), so we must
  // use ET dates — not UTC dates — to correctly group a night's slate of games.
  function toEasternDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  }

  const earliestDate = events.map((e) => toEasternDate(e.date)).sort()[0]
  const sameDay = events.filter((e) => toEasternDate(e.date) === earliestDate)

  console.log(`[odds-api] ${events.length} pending events total — filtered to ${sameDay.length} on ${earliestDate} ET`)

  return sameDay.map((e) => ({
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
    let res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[odds-api.io] /odds/multi failed: ${res.status} ${body}`)
      if (res.status === 429) {
        // Rate limited — wait 60s then retry this batch once
        console.warn(`[odds-api.io] rate limited — waiting 60s before retry`)
        await new Promise((r) => setTimeout(r, 60_000))
        res = await fetch(url, { cache: 'no-store' })
        if (!res.ok) {
          console.error(`[odds-api.io] retry also failed: ${res.status} — skipping batch (${batch.length} games lost)`)
          continue
        }
        // retry succeeded — fall through to normal parsing
      } else {
        continue
      }
    }

    const data = await res.json() as IOEventWithOdds[] | { data?: IOEventWithOdds[] }
    const eventList: IOEventWithOdds[] = Array.isArray(data) ? data : (data.data ?? [])

    for (const event of eventList) {
      // Prefer commence_time from the /events response; fall back to date on odds response
      const meta = events.find((e) => e.id === String(event.id))
      const enriched: EventWithProps = {
        ...event,
        home_team: event.home,
        away_team: event.away,
        commence_time: meta?.commence_time ?? event.date,
      }
      allProps.push(...parsePropsFromEvent(enriched))
    }
  }

  return allProps
}

function decimalToAmerican(decimal: number): number {
  if (decimal >= 2) return Math.round((decimal - 1) * 100)
  return Math.round(-100 / (decimal - 1))
}

export function parsePropsFromEvent(event: EventWithProps): Prop[] {
  const props: Prop[] = []

  for (const [bookmaker, markets] of Object.entries(event.bookmakers ?? {})) {
    // Parse ALL markets — catches both standard and alt "Player Props" market objects
    for (const ppMarket of markets) {
      for (const entry of ppMarket.odds) {
        if (!entry.label || entry.hdp == null) continue

        // Label format: "Player Name (Stat Type)"
        const match = entry.label.match(/^(.+) \(([^)]+)\)$/)
        if (!match) continue

        const playerName = match[1].trim()
        const statKey = match[2].trim()
        const statType = LABEL_STAT_MAP[statKey]
        if (!statType) continue // skip combo props we don't model (Pts+Rebs, Double+Double, etc.)

        const directions: Direction[] = ['over', 'under']
        for (const direction of directions) {
          const decimal = parseFloat(direction === 'over' ? entry.over : entry.under)
          props.push({
            player_id: 0,
            player_name: playerName,
            team: 'TBD',
            opponent: 'TBD',
            game_id: String(event.id),
            stat_type: statType,
            line: entry.hdp,
            direction,
            odds: isNaN(decimal) ? undefined : decimalToAmerican(decimal),
            sportsbook: bookmaker,
            commence_time: event.commence_time,
            home_team: event.home_team,
            away_team: event.away_team,
            cached_at: new Date().toISOString(),
          })
        }
      }
    }
  }

  return props
}
