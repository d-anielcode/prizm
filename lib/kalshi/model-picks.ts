// Pure helpers for Kalshi "model picks": Prizm's sportsbook confidence model applied to
// exact-match Kalshi rungs. A rung "N+" is YES if stat >= N, i.e. a sportsbook OVER at
// line N - 0.5; an UNDER at that line is buying NO at 1 - yes_bid.

import { applyCalibration } from '@/lib/calibration'
import { MAX_MODEL_MARKET_GAP } from '@/lib/ev'
import { playerNameVariants } from '@/lib/player-aliases'
import { normalizePlayerName } from '@/lib/lineups'
import { kalshiFee, type MarketRow, type MarketStat } from '@/lib/kalshi/ladder'

export interface ScoredLine {
  player_name: string
  stat_type: string
  line: number
  direction: 'over' | 'under' | string
  confidence_score: number
  confidence_label: string | null
  commence_time: string
}

export type PickTier = 'LOCK' | 'PLAY'
export type PickSide = 'yes' | 'no'

export interface ModelPick {
  ticker: string
  side: PickSide
  player: string
  stat: MarketStat
  strike: number
  game_date: string
  away: string
  home: string
  tier: PickTier
  modelP: number
  price: number
  fee: number
  edge: number
  commence_time: string
}

/** Stats a sportsbook line can map onto. DD/TD have no over/under line. */
const PICK_STATS = new Set<string>(['points', 'rebounds', 'assists', 'three_pointers', 'pra'])
const MIN_PRICE = 0.05
const MAX_PRICE = 0.95
const MAX_SPREAD_CENTS = 10

const round = (x: number, dp: number) => Math.round(x * 10 ** dp) / 10 ** dp
const key = (player: string, stat: string, strike: number) => `${player}|${stat}|${strike}`

export function matchPicks(markets: MarketRow[], scored: ScoredLine[]): ModelPick[] {
  // Index rungs by every normalized spelling of the Kalshi player name.
  const rungs = new Map<string, MarketRow>()
  for (const m of markets) {
    if (!PICK_STATS.has(m.stat)) continue
    for (const v of new Set(playerNameVariants(m.player).map(normalizePlayerName))) {
      rungs.set(key(v, m.stat, Number(m.strike)), m)
    }
  }

  const best = new Map<string, { pick: ModelPick; score: number }>()
  for (const s of scored) {
    if (s.confidence_label !== 'LOCK' && s.confidence_label !== 'PLAY') continue
    if (!PICK_STATS.has(s.stat_type) || s.confidence_score == null) continue
    if (s.direction !== 'over' && s.direction !== 'under') continue
    const m = rungs.get(key(normalizePlayerName(s.player_name), s.stat_type, Number(s.line) + 0.5))
    if (!m) continue

    const { yes_bid: bid, yes_ask: ask } = m
    if (bid == null || ask == null || bid <= 0 || ask <= 0) continue
    if (Math.round((ask - bid) * 100) > MAX_SPREAD_CENTS) continue

    const side: PickSide = s.direction === 'over' ? 'yes' : 'no'
    const price = side === 'yes' ? ask : round(1 - bid, 4)
    if (price < MIN_PRICE || price > MAX_PRICE) continue

    const modelP = applyCalibration(s.confidence_score, s.stat_type) / 100
    const fee = kalshiFee(price)
    const edge = modelP - (price + fee)
    if (!(edge > 0 && edge <= MAX_MODEL_MARKET_GAP)) continue

    const id = `${m.ticker}|${side}`
    const prev = best.get(id)
    if (prev && prev.score >= s.confidence_score) continue
    best.set(id, {
      score: s.confidence_score,
      pick: {
        ticker: m.ticker, side, player: m.player, stat: m.stat, strike: Number(m.strike),
        game_date: m.game_date, away: m.away, home: m.home, tier: s.confidence_label,
        modelP, price, fee, edge, commence_time: s.commence_time,
      },
    })
  }
  return [...best.values()].map((b) => b.pick).sort((a, b) => b.edge - a.edge)
}

// ── Record / display helpers ────────────────────────────────────────────────

type Num = number | string | null
export interface GradedRow { result: string | null; won: boolean | null; pnl: Num; price: Num; fee: Num }
export interface RecordSummary { n: number; wins: number; winRate: number | null; pnl: number; staked: number; roi: number | null }

/** Graded, non-void rows only. ROI = sum pnl / sum (price + fee). */
export function summarizeRecord(rows: GradedRow[]): RecordSummary {
  let n = 0, wins = 0, pnl = 0, staked = 0
  for (const r of rows) {
    if (r.result !== 'yes' && r.result !== 'no') continue
    n++
    if (r.won) wins++
    pnl += Number(r.pnl ?? 0)
    staked += Number(r.price ?? 0) + Number(r.fee ?? 0)
  }
  return { n, wins, winRate: n ? wins / n : null, pnl, staked, roi: staked > 0 ? pnl / staked : null }
}

const RUNG_NOUN: Record<MarketStat, string> = {
  points: 'points', rebounds: 'rebounds', assists: 'assists', three_pointers: 'threes',
  pra: 'pts+reb+ast', double_double: 'double-double', triple_double: 'triple-double',
}

/** "25+ points". */
export function rungLabel(stat: MarketStat, strike: number): string {
  return `${strike}+ ${RUNG_NOUN[stat] ?? stat}`
}

export interface PickGame { key: string; away: string; home: string; picks: ModelPick[] }

/** Picks grouped by "AWY@HOM" (sorted); input order (edge desc) is kept within a game. */
export function groupPicksByGame(picks: ModelPick[]): PickGame[] {
  const games = new Map<string, PickGame>()
  for (const p of picks) {
    const k = `${p.away}@${p.home}`
    let g = games.get(k)
    if (!g) { g = { key: k, away: p.away, home: p.home, picks: [] }; games.set(k, g) }
    g.picks.push(p)
  }
  return [...games.values()].sort((a, b) => a.key.localeCompare(b.key))
}
