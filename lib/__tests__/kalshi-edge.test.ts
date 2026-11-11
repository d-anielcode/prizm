import { describe, it, expect } from 'vitest'
import { pocketLabel, chartPoints, STATUS_LABEL } from '@/lib/kalshi/edge'

describe('pocketLabel', () => {
  it('formats ids readably', () => {
    expect(pocketLabel('no|band:.05-.10')).toBe('NO · 5–10¢')
    expect(pocketLabel('yes|band:.10-.20|stat:pra')).toBe('YES · 10–20¢ · Pts+Reb+Ast')
    expect(pocketLabel('yes|pos:top')).toBe('YES · top rung')
    expect(pocketLabel('no|spread:>10')).toBe('NO · spread >10¢')
    expect(pocketLabel('yes|vol:100+')).toBe('YES · volume 100+')
  })
  it('has a label for every status', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(
      ['confirmed', 'discovery_pass', 'failed_confirmation', 'failed_forward', 'live', 'rejected'])
  })
})

describe('chartPoints', () => {
  it('maps probability 0..1 to the plot box (y inverted)', () => {
    const [p] = chartPoints([{ season: '2025-26', band: '.10-.20', n: 10, mean_ask: 0.1, yes_rate: 0.2 }], 200, 100, 10)
    expect(p.x).toBeCloseTo(10 + 0.1 * 180)
    expect(p.y).toBeCloseTo(10 + (1 - 0.2) * 80)
  })
  it('plots the mid when present, falling back to the ask', () => {
    const [m, a] = chartPoints([
      { season: '2025-26', band: '.10-.20', n: 10, mean_ask: 0.14, mean_mid: 0.12, yes_rate: 0.2 },
      { season: '2025-26', band: '.20-.35', n: 10, mean_ask: 0.3, mean_mid: null, yes_rate: 0.2 },
    ], 200, 100, 10)
    expect(m.price).toBeCloseTo(0.12)
    expect(m.x).toBeCloseTo(10 + 0.12 * 180)
    expect(a.price).toBeCloseTo(0.3)
    expect(a.x).toBeCloseTo(10 + 0.3 * 180)
  })
  it('treats PostgREST numeric strings as numbers', () => {
    const [p] = chartPoints([{ season: '2025-26', band: '.10-.20', n: 10, mean_ask: '0.14', mean_mid: '0.12', yes_rate: '0.2' } as never], 200, 100, 10)
    expect(p.price).toBeCloseTo(0.12)
  })
})
