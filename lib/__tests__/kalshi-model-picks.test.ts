import { describe, it, expect, vi } from 'vitest'

// Identity calibration so expected probabilities are readable: score 70 -> 0.70.
vi.mock('@/lib/calibration', () => ({ applyCalibration: (s: number) => s }))

import {
  matchPicks, summarizeRecord, rungLabel, groupPicksByGame, etDayWindow, dueForLogging, toLogRow, type ScoredLine, type ModelPick,
} from '@/lib/kalshi/model-picks'
import { kalshiFee, type MarketRow } from '@/lib/kalshi/ladder'

const mkt = (o: Partial<MarketRow>): MarketRow => ({
  ticker: 'KXNBAPTS-26NOV11BOSNYK-JBROWN7-25', stat: 'points', player: 'Jaylen Brown', strike: 25,
  game_date: '2026-11-11', away: 'BOS', home: 'NYK', yes_bid: 0.55, yes_ask: 0.58, first_yes_ask: null,
  volume: 100, status: 'active', updated_at: '2026-11-11T20:00:00Z', ...o,
})
const line = (o: Partial<ScoredLine>): ScoredLine => ({
  player_name: 'Jaylen Brown', stat_type: 'points', line: 24.5, direction: 'over',
  confidence_score: 65, confidence_label: 'LOCK', commence_time: '2026-11-12T00:30:00Z', ...o,
})

describe('matchPicks mapping', () => {
  it('maps an over at line N-0.5 to YES on rung N at yes_ask', () => {
    const [p, ...rest] = matchPicks([mkt({})], [line({})])
    expect(rest).toHaveLength(0)
    expect(p.side).toBe('yes')
    expect(p.strike).toBe(25)
    expect(p.price).toBe(0.58)
    expect(p.fee).toBeCloseTo(kalshiFee(0.58))
    expect(p.modelP).toBeCloseTo(0.65)
    expect(p.edge).toBeCloseTo(0.65 - 0.58 - kalshiFee(0.58))
    expect(p).toMatchObject({ ticker: mkt({}).ticker, player: 'Jaylen Brown', stat: 'points', tier: 'LOCK',
      game_date: '2026-11-11', away: 'BOS', home: 'NYK', commence_time: '2026-11-12T00:30:00Z' })
  })

  it('requires strike === line + 0.5', () => {
    expect(matchPicks([mkt({ strike: 26 })], [line({})])).toHaveLength(0)
  })

  it('maps an under to NO at 1 - yes_bid, rounded to 4dp', () => {
    const [p] = matchPicks([mkt({ yes_bid: 0.333, yes_ask: 0.35 })], [line({ direction: 'under', confidence_score: 70 })])
    expect(p.side).toBe('no')
    expect(p.price).toBe(0.667)
    expect(p.edge).toBeCloseTo(0.70 - 0.667 - kalshiFee(0.667))
  })

  it('matches names through normalization and aliases', () => {
    const picks = matchPicks([mkt({ player: 'Nikola Jokić' })], [line({ player_name: 'Nikola Jokic' })])
    expect(picks).toHaveLength(1)
  })

  it('requires same stat', () => {
    expect(matchPicks([mkt({ stat: 'rebounds' })], [line({})])).toHaveLength(0)
  })
})

describe('matchPicks filters', () => {
  it('excludes FADE and null labels', () => {
    expect(matchPicks([mkt({})], [line({ confidence_label: 'FADE' })])).toHaveLength(0)
    expect(matchPicks([mkt({})], [line({ confidence_label: null })])).toHaveLength(0)
  })
  it('excludes DD/TD markets', () => {
    expect(matchPicks([mkt({ stat: 'double_double', strike: 1 })], [line({ stat_type: 'double_double', line: 0.5 })])).toHaveLength(0)
  })
  it('price band .05 - .95', () => {
    expect(matchPicks([mkt({ yes_bid: 0.03, yes_ask: 0.04 })], [line({ confidence_score: 10 })])).toHaveLength(0)
    expect(matchPicks([mkt({ yes_bid: 0.95, yes_ask: 0.96 })], [line({ confidence_score: 99 })])).toHaveLength(0)
  })
  it('missing price or an empty side', () => {
    expect(matchPicks([mkt({ yes_ask: null })], [line({})])).toHaveLength(0)
    expect(matchPicks([mkt({ yes_bid: null })], [line({})])).toHaveLength(0)
    expect(matchPicks([mkt({ yes_bid: 0 })], [line({})])).toHaveLength(0)
  })
  it('spread over 10 cents', () => {
    expect(matchPicks([mkt({ yes_bid: 0.47, yes_ask: 0.58 })], [line({})])).toHaveLength(0)
    expect(matchPicks([mkt({ yes_bid: 0.48, yes_ask: 0.58 })], [line({})])).toHaveLength(1)
  })
  it('keeps only 0 < edge <= 0.10', () => {
    expect(matchPicks([mkt({})], [line({ confidence_score: 59 })])).toHaveLength(0) // negative edge
    expect(matchPicks([mkt({})], [line({ confidence_score: 75 })])).toHaveLength(0) // edge > cap
  })
})

describe('matchPicks dedupe and sort', () => {
  it('same ticker/side from props and prop_alts keeps the higher score', () => {
    const picks = matchPicks([mkt({})], [line({ confidence_score: 62, confidence_label: 'PLAY' }), line({ confidence_score: 66 })])
    expect(picks).toHaveLength(1)
    expect(picks[0].modelP).toBeCloseTo(0.66)
    expect(picks[0].tier).toBe('LOCK')
  })
  it('YES and NO on the same rung are separate picks', () => {
    const m = mkt({ yes_bid: 0.5, yes_ask: 0.52 })
    const picks = matchPicks([m], [line({ confidence_score: 58 }), line({ direction: 'under', confidence_score: 54 })])
    expect(picks.map((p) => p.side).sort()).toEqual(['no', 'yes'])
  })
  it('sorts by edge desc', () => {
    const markets = [mkt({}), mkt({ ticker: 'T2', player: 'Jalen Brunson', yes_bid: 0.40, yes_ask: 0.42 })]
    const picks = matchPicks(markets, [line({ confidence_score: 61 }), line({ player_name: 'Jalen Brunson', confidence_score: 50 })])
    expect(picks.map((p) => p.ticker)).toEqual(['T2', mkt({}).ticker])
  })
})

describe('summarizeRecord', () => {
  it('counts graded non-void rows; ROI = pnl / staked', () => {
    const r = summarizeRecord([
      { result: 'yes', won: true, pnl: 0.4, price: 0.58, fee: 0.02 },
      { result: 'no', won: false, pnl: -0.62, price: 0.6, fee: 0.02 },
      { result: 'void', won: null, pnl: 0, price: 0.5, fee: 0.02 },
      { result: null, won: null, pnl: null, price: 0.5, fee: 0.02 },
    ])
    expect(r.n).toBe(2)
    expect(r.wins).toBe(1)
    expect(r.winRate).toBeCloseTo(0.5)
    expect(r.pnl).toBeCloseTo(-0.22)
    expect(r.roi).toBeCloseTo(-0.22 / 1.22)
  })
  it('empty is zeros with null rates', () => {
    expect(summarizeRecord([])).toEqual({ n: 0, wins: 0, winRate: null, pnl: 0, staked: 0, roi: null })
  })
  it('coerces numeric strings from PostgREST', () => {
    const r = summarizeRecord([{ result: 'yes', won: true, pnl: '0.4', price: '0.58', fee: '0.02' }])
    expect(r.roi).toBeCloseTo(0.4 / 0.6)
  })
})

describe('display helpers', () => {
  it('rungLabel', () => {
    expect(rungLabel('points', 25)).toBe('25+ points')
    expect(rungLabel('three_pointers', 3)).toBe('3+ threes')
    expect(rungLabel('pra', 40)).toBe('40+ pts+reb+ast')
  })
  it('groupPicksByGame keeps edge order inside a game, games sorted by key', () => {
    const p = (ticker: string, away: string, edge: number) => ({ ticker, away, home: 'NYK', edge } as unknown as ModelPick)
    const g = groupPicksByGame([p('a', 'BOS', 0.05), p('b', 'ATL', 0.04), p('c', 'BOS', 0.03)])
    expect(g.map((x) => x.key)).toEqual(['ATL@NYK', 'BOS@NYK'])
    expect(g[1].picks.map((x) => x.ticker)).toEqual(['a', 'c'])
  })
})

describe('etDayWindow', () => {
  it('EST date', () => {
    expect(etDayWindow('2026-11-11')).toEqual({ start: '2026-11-11T05:00:00.000Z', end: '2026-11-12T05:00:00.000Z' })
  })
  it('EDT date', () => {
    expect(etDayWindow('2026-10-21')).toEqual({ start: '2026-10-21T04:00:00.000Z', end: '2026-10-22T04:00:00.000Z' })
  })
})

describe('logging helpers', () => {
  const base = matchPicks([mkt({})], [line({})])[0]
  const now = new Date('2026-11-12T00:00:00Z')
  it('dueForLogging keeps games tipping in (now, now+30m]', () => {
    const at = (iso: string) => ({ ...base, commence_time: iso })
    const due = dueForLogging([at('2026-11-12T00:30:00Z'), at('2026-11-12T00:31:00Z'), at('2026-11-12T00:00:00Z'), at('2026-11-11T23:50:00Z'), at('bad')], now)
    expect(due.map((p) => p.commence_time)).toEqual(['2026-11-12T00:30:00Z'])
  })
  it('toLogRow rounds price/model_p/edge 4dp and fee 6dp', () => {
    const r = toLogRow({ ...base, price: 0.58, fee: 0.0170520001, modelP: 0.651234, edge: 0.0541819 })
    expect(r).toEqual({ ticker: base.ticker, side: 'yes', player: 'Jaylen Brown', stat: 'points', strike: 25,
      game_date: '2026-11-11', tier: 'LOCK', model_p: 0.6512, price: 0.58, fee: 0.017052, edge: 0.0542 })
  })
})
