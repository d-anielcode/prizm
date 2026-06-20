// odds-api.io — fetches NBA player props
// Free tier: 100 requests/hour
// Optimized: 1 req for events + ceil(games/10) reqs for props via /odds/multi
//
// API format: all player props live under a single "Player Props" market.
// Each entry label is "Player Name (Stat Type)", e.g. "LeBron James (Points)"

import type { Prop, StatType, Direction } from '@/types'

const BASE_URL = 'https://api.odds-api.io/v3'
// Deferred env-var check — module-init throws break Next 16 build-time
// page-data collection on Vercel (build env doesn't have runtime secrets).
function apiKey(): string {
  const k = process.env.ODDS_API_IO_KEY
  if (!k) throw new Error('Missing ODDS_API_IO_KEY environment variable')
  return k
}
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

/**
 * True if the parsed "player name" actually looks like an individual player
 * rather than a team total or alternate-total market posing under the same
 * "Name (Stat)" label format.
 *
 * Observed non-player names from odds-api.io as of 2026-05:
 *   "Both Teams"                          -- combined game total
 *   "MIN Timberwolves Alternate"          -- team alt total
 *   "SA Spurs Alternate"                  -- team alt total
 *   plus exact home_team / away_team names
 *
 * These slip through parsePropsFromEvent because the regex only enforces
 * the bracket format. Without this guard the confidence engine scores team
 * totals as if they were player props — which then surfaces as huge
 * fake-edge picks on /edge (Module 6 of the diagnostic flagged this).
 */
export function isPlayerName(name: string, homeTeam?: string, awayTeam?: string): boolean {
  if (!name) return false
  const trimmed = name.trim()
  if (trimmed === 'Both Teams') return false
  if (trimmed.endsWith(' Alternate')) return false
  if (trimmed.endsWith(' Total')) return false
  if (homeTeam && trimmed === homeTeam) return false
  if (awayTeam && trimmed === awayTeam) return false
  return true
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

// NBA games live under different league slugs by season phase: `usa-nba` during
// the regular season, `usa-nba-playoffs` during the postseason. Querying only
// `usa-nba` returned 0 events once the Finals moved to the playoffs slug, which
// silently froze the props slate. Query both and merge — robust across the
// boundary with no date-based season detection.
const NBA_LEAGUES = ['usa-nba', 'usa-nba-playoffs'] as const

function toEasternDate(iso: string): string {
  // NBA games can tip after midnight UTC (8 PM ET = 00:00 UTC next day), so we
  // group a night's slate by ET date, not UTC date.
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Pure slate selection: dedupe merged events by id, then keep only the games on
// the earliest ET date (the next slate). Filtering to the nearest date prevents
// processing 100+ events across two weeks, which causes timeouts and cross-day
// dedup collisions. Exported for unit testing.
export function selectEarliestSlate(events: IOEvent[]): NBAEvent[] {
  if (events.length === 0) return []

  const byId = new Map<number, IOEvent>()
  for (const e of events) if (!byId.has(e.id)) byId.set(e.id, e)
  const unique = [...byId.values()]

  const earliestDate = unique.map((e) => toEasternDate(e.date)).sort()[0]
  const sameDay = unique.filter((e) => toEasternDate(e.date) === earliestDate)

  return sameDay.map((e) => ({
    id: String(e.id),
    home_team: e.home,
    away_team: e.away,
    commence_time: e.date,
  }))
}

const WNBA_LEAGUES = ['usa-wnba'] as const

// Step 1: Get the next pending slate for the given league slugs (one request per slug).
export async function fetchEventsForLeagues(leagues: readonly string[]): Promise<NBAEvent[]> {
  const all: IOEvent[] = []
  let okCount = 0
  let lastErr = ''

  for (const league of leagues) {
    const url = `${BASE_URL}/events?apiKey=${apiKey()}&sport=basketball&league=${league}&status=pending`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      lastErr = `${league}: ${res.status} ${await res.text()}`
      console.error(`[odds-api] events failed — ${lastErr}`)
      continue
    }
    okCount++
    const data = await res.json() as { data?: IOEvent[] } | IOEvent[]
    const events: IOEvent[] = Array.isArray(data) ? data : (data.data ?? [])
    all.push(...events)
  }

  // Throw only if EVERY league query failed (a real API/key outage). A single
  // empty/404 slug (e.g. usa-nba during the playoffs) is normal and tolerated.
  if (okCount === 0) throw new Error(`odds-api.io events failed for all leagues: ${lastErr}`)

  const slate = selectEarliestSlate(all)
  const date = slate[0]?.commence_time ? toEasternDate(slate[0].commence_time) : 'n/a'
  console.log(`[odds-api] ${all.length} pending events across ${okCount} league(s) — filtered to ${slate.length} on ${date} ET`)
  return slate
}

export const fetchTodaysNBAEvents = (): Promise<NBAEvent[]> => fetchEventsForLeagues(NBA_LEAGUES)
export const fetchTodaysWNBAEvents = (): Promise<NBAEvent[]> => fetchEventsForLeagues(WNBA_LEAGUES)

// Step 2: Fetch props for ALL events in batches of 10 (ceil(N/10) requests)
export async function fetchAllPropsForEvents(events: NBAEvent[]): Promise<Prop[]> {
  const allProps: Prop[] = []
  const BATCH = 10

  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH)
    const ids = batch.map((e) => e.id).join(',')

    const url = `${BASE_URL}/odds/multi?apiKey=${apiKey()}&eventIds=${ids}&bookmakers=${BOOKMAKERS}`
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
        // Skip team-total markets (Both Teams, "<ABBR> <Name> Alternate", etc.) —
        // they share the "Name (Stat)" label format but aren't player props.
        if (!isPlayerName(playerName, event.home_team, event.away_team)) continue

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
