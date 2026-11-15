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

export type PickTier = 'LOCK' | 'PLAY' | 'STRETCH'
export type PickKind = 'exact' | 'stretched'
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
  kind: PickKind
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

/** Stretched (full-ladder) picks show on Home/Feed only once the 2025-26 replay passes
 *  (spec 2026-11-11). Until then they are logged and graded, visible on Performance only. */
export const STRETCHED_VISIBLE = false
/** kalshi_model_rungs rows older than this are ignored (a dead step means no picks, not stale ones). */
export const RUNG_MAX_AGE_MIN = 45

export interface ModelRung {
  ticker: string
  model_p: number
  exact: boolean
  commence_time: string | null
  computed_at: string
}

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
        game_date: m.game_date, away: m.away, home: m.home, tier: s.confidence_label, kind: 'exact',
        modelP, price, fee, edge, commence_time: s.commence_time,
      },
    })
  }
  return [...best.values()].map((b) => b.pick).sort((a, b) => b.edge - a.edge)
}

/** Picks on rungs priced by the full-ladder bridge (kalshi_model_rungs), excluding exact
 *  rungs (left to matchPicks). Same book/price/edge filters as exact picks; the better side wins.
 *  Rungs marked exact in kalshi_model_rungs (any scored book line, any label, incl. FADE) never get
 *  a stretched pick: deliberate, so a FADE book line can't be bypassed. */
export function matchStretched(markets: MarketRow[], rungs: ModelRung[], now: Date): ModelPick[] {
  const byTicker = new Map(rungs.map((r) => [r.ticker, r]))
  const out: ModelPick[] = []
  for (const m of markets) {
    if (!PICK_STATS.has(m.stat)) continue
    const r = byTicker.get(m.ticker)
    if (!r || r.exact || r.commence_time == null) continue
    const age = now.getTime() - Date.parse(r.computed_at)
    if (!Number.isFinite(age) || age > RUNG_MAX_AGE_MIN * 60_000) continue
    const { yes_bid: bid, yes_ask: ask } = m
    if (bid == null || ask == null || bid <= 0 || ask <= 0) continue
    if (Math.round((ask - bid) * 100) > MAX_SPREAD_CENTS) continue

    let best: ModelPick | null = null
    for (const side of ['yes', 'no'] as const) {
      const price = side === 'yes' ? ask : round(1 - bid, 4)
      if (price < MIN_PRICE || price > MAX_PRICE) continue
      const modelP = side === 'yes' ? Number(r.model_p) : 1 - Number(r.model_p)
      const fee = kalshiFee(price)
      const edge = modelP - (price + fee)
      if (!(edge > 0 && edge <= MAX_MODEL_MARKET_GAP)) continue
      if (best && best.edge >= edge) continue
      best = {
        ticker: m.ticker, side, player: m.player, stat: m.stat, strike: Number(m.strike),
        game_date: m.game_date, away: m.away, home: m.home, tier: 'STRETCH', kind: 'stretched',
        modelP, price, fee, edge, commence_time: r.commence_time,
      }
    }
    if (best) out.push(best)
  }
  return out.sort((a, b) => b.edge - a.edge)
}

/** Stretched picks minus any ticker that already has an exact pick (exact always wins). */
export function dropExactOverlap(exact: ModelPick[], stretched: ModelPick[]): ModelPick[] {
  const taken = new Set(exact.map((p) => p.ticker))
  return stretched.filter((p) => !taken.has(p.ticker))
}

/** Combines exact and stretched picks for a day. Pure; `rungs` may be empty. */
export function combinePicks(markets: MarketRow[], scored: ScoredLine[], rungs: ModelRung[], now: Date) {
  const picks = matchPicks(markets, scored)
  const stretched = dropExactOverlap(picks, matchStretched(markets, rungs, now))
  return { picks, stretched, visible: visiblePicks(picks, stretched) }
}

/** Logged rows counted in the headline record: stretched ones only once STRETCHED_VISIBLE. */
export function shownRows<T extends { kind?: string | null }>(rows: T[], showStretched = STRETCHED_VISIBLE): T[] {
  return showStretched ? rows : rows.filter((r) => r.kind !== 'stretched')
}

/** Picks shown on Home/Feed: exact only, or exact + stretched by edge once STRETCHED_VISIBLE. */
export function visiblePicks(exact: ModelPick[], stretched: ModelPick[], showStretched = STRETCHED_VISIBLE): ModelPick[] {
  return showStretched ? [...exact, ...stretched].sort((a, b) => b.edge - a.edge) : exact
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

/** [start, end) of an ET calendar date as UTC ISO strings. Uses the offset at ET noon. */
export function etDayWindow(date: string): { start: string; end: string } {
  const noon = new Date(`${date}T12:00:00Z`)
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(noon).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5'
  const hours = Number(name.replace('GMT', '') || 0)
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - hours * 3_600_000)
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() }
}

/** Picks whose game tips within the next `minutes` (and not already started). */
export function dueForLogging(picks: ModelPick[], now: Date, minutes = 30): ModelPick[] {
  const t = now.getTime()
  return picks.filter((p) => {
    const tip = Date.parse(p.commence_time)
    return Number.isFinite(tip) && tip > t && tip - t <= minutes * 60_000
  })
}

/** kalshi_model_picks insert row: price/model_p/edge at 4dp, fee at 6dp. */
export function toLogRow(p: ModelPick) {
  return {
    ticker: p.ticker, side: p.side, player: p.player, stat: p.stat, strike: p.strike,
    game_date: p.game_date, tier: p.tier, kind: p.kind,
    model_p: round(p.modelP, 4), price: round(p.price, 4), fee: round(p.fee, 6), edge: round(p.edge, 4),
  }
}

/** summarizeRecord per group key, groups sorted by key. */
export function summarizeBy<T extends GradedRow>(rows: T[], keyOf: (r: T) => string): { key: string; record: RecordSummary }[] {
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const k = keyOf(r)
    const list = groups.get(k)
    if (list) list.push(r)
    else groups.set(k, [r])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rs]) => ({ key, record: summarizeRecord(rs) }))
}
