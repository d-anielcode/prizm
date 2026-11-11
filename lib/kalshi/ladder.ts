// Pure helpers for the Prediction Markets Props tab (Kalshi "N+" ladders).

export const MARKET_STATS = [
  'points', 'rebounds', 'assists', 'three_pointers', 'pra', 'double_double', 'triple_double',
] as const
export type MarketStat = (typeof MARKET_STATS)[number]

export const STAT_LABEL: Record<MarketStat, string> = {
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists', three_pointers: 'Threes',
  pra: 'Pts+Reb+Ast', double_double: 'Double-double', triple_double: 'Triple-double',
}

export interface MarketRow {
  ticker: string
  stat: MarketStat
  player: string
  strike: number
  game_date: string
  away: string
  home: string
  yes_bid: number | null
  yes_ask: number | null
  first_yes_ask: number | null
  volume: number
  status: string | null
  updated_at: string
}

export interface LadderLog {
  game_date: string
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  fg3m: number
  pra: number | null
  minutes: number | null
}

/** Kalshi taker fee per contract at price p (0..1), before per-order cent rounding. */
export function kalshiFee(p: number): number {
  return 0.07 * p * (1 - p)
}

/** Probability the YES side must hit to break even buying at `ask`. */
export function breakEven(ask: number): number {
  return ask + kalshiFee(ask)
}

function tens(l: LadderLog): number {
  return [l.points, l.rebounds, l.assists, l.steals, l.blocks].filter((v) => (v ?? 0) >= 10).length
}
export const isDoubleDouble = (l: LadderLog) => tens(l) >= 2
export const isTripleDouble = (l: LadderLog) => tens(l) >= 3

export function statValue(l: LadderLog, stat: MarketStat): number {
  switch (stat) {
    case 'points': return l.points
    case 'rebounds': return l.rebounds
    case 'assists': return l.assists
    case 'three_pointers': return l.fg3m
    case 'pra': return l.pra ?? l.points + l.rebounds + l.assists
    case 'double_double': return isDoubleDouble(l) ? 1 : 0
    case 'triple_double': return isTripleDouble(l) ? 1 : 0
  }
}

export interface HitRate { hits: number; games: number }

/** Hit rate of "strike+" over played games (minutes > 0). `logs` must be newest first.
 *  Window: { last: n } = most recent n played games; { from, to } = inclusive dates. */
export function hitRate(
  logs: LadderLog[], stat: MarketStat, strike: number,
  window: { last: number } | { from: string; to: string },
): HitRate {
  let played = logs.filter((l) => (l.minutes ?? 0) > 0)
  played = 'last' in window
    ? played.slice(0, window.last)
    : played.filter((l) => l.game_date >= window.from && l.game_date <= window.to)
  return { hits: played.filter((l) => statValue(l, stat) >= strike).length, games: played.length }
}

export interface StatLadder { stat: MarketStat; rungs: MarketRow[] }
export interface PlayerLadders { player: string; stats: StatLadder[] }
export interface GameLadders { key: string; away: string; home: string; players: PlayerLadders[] }

/** game ("AWY@HOM", sorted) -> player (sorted) -> stat (MARKET_STATS order) -> rungs (strike asc). */
export function groupLadders(rows: MarketRow[]): GameLadders[] {
  const games = new Map<string, Map<string, MarketRow[]>>()
  for (const r of rows) {
    const key = `${r.away}@${r.home}`
    let players = games.get(key)
    if (!players) { players = new Map(); games.set(key, players) }
    let list = players.get(r.player)
    if (!list) { list = []; players.set(r.player, list) }
    list.push(r)
  }
  return [...games.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, players]) => {
    const [away, home] = key.split('@')
    return {
      key, away, home,
      players: [...players.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([player, rs]) => ({
        player,
        stats: MARKET_STATS
          .map((stat) => ({ stat, rungs: rs.filter((r) => r.stat === stat).sort((a, b) => a.strike - b.strike) }))
          .filter((s) => s.rungs.length > 0),
      })),
    }
  })
}

/** One log per game_date (first occurrence wins), newest first. Log writers disagree on
 *  name spelling, so alias-merged logs can repeat a game. */
export function dedupeLogsByDate<T extends { game_date: string }>(logs: T[]): T[] {
  const seen = new Map<string, T>()
  for (const l of logs) if (!seen.has(l.game_date)) seen.set(l.game_date, l)
  return [...seen.values()].sort((a, b) => b.game_date.localeCompare(a.game_date))
}
