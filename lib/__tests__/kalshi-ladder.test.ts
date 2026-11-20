import { describe, it, expect } from 'vitest'
import {
  kalshiFee, breakEven, isDoubleDouble, isTripleDouble, statValue, hitRate, groupLadders, dedupeLogsByDate,
  type LadderLog, type MarketRow,
} from '@/lib/kalshi/ladder'

const log = (o: Partial<LadderLog>): LadderLog => ({
  game_date: '2026-11-01', points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0,
  fg3m: 0, pra: null, minutes: 30, ...o })

describe('fees', () => {
  it('fee is 0.07 p (1-p)', () => { expect(kalshiFee(0.5)).toBeCloseTo(0.0175) })
  it('break-even is ask plus fee', () => { expect(breakEven(0.4)).toBeCloseTo(0.4 + 0.07 * 0.4 * 0.6) })
})

describe('double / triple double', () => {
  it('counts any two of pts/reb/ast/stl/blk at 10+', () => {
    expect(isDoubleDouble(log({ points: 10, rebounds: 10 }))).toBe(true)
    expect(isDoubleDouble(log({ points: 25, blocks: 10 }))).toBe(true)
    expect(isDoubleDouble(log({ points: 30, rebounds: 9 }))).toBe(false)
  })
  it('triple needs three', () => {
    expect(isTripleDouble(log({ points: 10, rebounds: 10, assists: 10 }))).toBe(true)
    expect(isTripleDouble(log({ points: 30, rebounds: 15, assists: 9 }))).toBe(false)
  })
})

describe('statValue', () => {
  it('maps threes to fg3m and computes pra when null', () => {
    expect(statValue(log({ fg3m: 4 }), 'three_pointers')).toBe(4)
    expect(statValue(log({ points: 20, rebounds: 5, assists: 5 }), 'pra')).toBe(30)
    expect(statValue(log({ points: 20, rebounds: 5, assists: 5, pra: 31 }), 'pra')).toBe(31)
  })
  it('DD/TD are 1 or 0', () => {
    expect(statValue(log({ points: 10, assists: 10 }), 'double_double')).toBe(1)
    expect(statValue(log({ points: 10 }), 'triple_double')).toBe(0)
  })
})

describe('hitRate', () => {
  const logs = [ // newest first
    log({ game_date: '2026-11-05', points: 30 }),
    log({ game_date: '2026-11-03', points: 20 }),
    log({ game_date: '2026-11-01', points: 0, minutes: 0 }),   // DNP, ignored
    log({ game_date: '2026-04-10', points: 26 }),              // last season
  ]
  it('last-N uses played games only', () => {
    expect(hitRate(logs, 'points', 25, { last: 2 })).toEqual({ hits: 1, games: 2 })
    expect(hitRate(logs, 'points', 25, { last: 10 })).toEqual({ hits: 2, games: 3 })
  })
  it('season window filters by date', () => {
    expect(hitRate(logs, 'points', 25, { from: '2026-10-01', to: '2027-09-30' })).toEqual({ hits: 1, games: 2 })
  })
})

describe('groupLadders', () => {
  const row = (o: Partial<MarketRow>): MarketRow => ({
    ticker: 't', stat: 'points', player: 'A B', strike: 25, game_date: '2026-11-06',
    away: 'MIN', home: 'NOP', yes_bid: 0.4, yes_ask: 0.42, first_yes_ask: 0.42,
    volume: 10, status: 'active', updated_at: '2026-11-06T20:00:00Z', ...o })
  it('groups game -> player -> stat with rungs ascending', () => {
    const g = groupLadders([
      row({ ticker: 'a30', strike: 30 }), row({ ticker: 'a20', strike: 20 }),
      row({ ticker: 'b', player: 'C D', stat: 'rebounds', strike: 8 }),
      row({ ticker: 'c', away: 'BOS', home: 'CHA', player: 'E F' }),
    ])
    expect(g.map((x) => x.key)).toEqual(['BOS@CHA', 'MIN@NOP'])
    const min = g[1]
    expect(min.players.map((p) => p.player)).toEqual(['A B', 'C D'])
    expect(min.players[0].stats[0].rungs.map((r) => r.strike)).toEqual([20, 30])
  })
  it('orders stats in display order', () => {
    const g = groupLadders([row({ ticker: 'x', stat: 'double_double', strike: 1 }), row({ ticker: 'y', stat: 'points' })])
    expect(g[0].players[0].stats.map((s) => s.stat)).toEqual(['points', 'double_double'])
  })
})

describe('dedupeLogsByDate', () => {
  it('keeps the first log per date and sorts newest first', () => {
    const a = log({ game_date: '2026-11-01', points: 10 })
    const b = log({ game_date: '2026-11-03', points: 20 })
    const dup = log({ game_date: '2026-11-01', points: 99 })
    const c = log({ game_date: '2026-11-02', points: 30 })
    expect(dedupeLogsByDate([a, b, dup, c])).toEqual([b, c, a])
  })
  it('handles empty input', () => { expect(dedupeLogsByDate([])).toEqual([]) })
})
