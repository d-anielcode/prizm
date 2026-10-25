import { describe, it, expect } from 'vitest'
import { americanToDecimal, ev, isSaneOdds } from '../ev'

describe('isSaneOdds', () => {
  it('accepts normal prop prices', () => {
    for (const o of [-500, -238, -110, 100, 145, 268, 500]) expect(isSaneOdds(o)).toBe(true)
  })

  // Regression: prop_history held -10000 / +3000 quotes (near-certain and longshot
  // alt lines); a few of them made backtests show +70% ROI and skew EV ranking.
  it('rejects extreme or malformed prices', () => {
    for (const o of [-10000, -501, 501, 3000, 0, 50, -99, NaN, Infinity]) expect(isSaneOdds(o)).toBe(false)
    expect(isSaneOdds(null)).toBe(false)
    expect(isSaneOdds(undefined)).toBe(false)
  })
})

describe('EV ignores insane odds', () => {
  it('returns null decimal and EV for out-of-range odds', () => {
    expect(americanToDecimal(3000)).toBeNull()
    expect(ev(60, 3000, 'points')).toBeNull()
  })

  it('still converts normal odds', () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.909, 3)
    expect(americanToDecimal(120)).toBeCloseTo(2.2, 3)
  })
})

import { modelVsMarket, MAX_MODEL_MARKET_GAP } from '../ev'

describe('modelVsMarket', () => {
  it('reports model %, market implied %, the gap and EV', () => {
    const v = modelVsMarket(60, -110, 'points')!
    expect(v.marketP).toBeCloseTo(110 / 210, 4)
    expect(v.gap).toBeCloseTo(v.modelP - v.marketP, 6)
    expect(v.ev).toBeCloseTo(v.modelP * (1 + 100 / 110) - 1, 6)
  })

  // Regression (2026-10-24): Marcus Smart O0.5 3PM at +450 showed "47% win,
  // +156% edge" because the score calibration ignores price.
  it('flags gaps beyond MAX_MODEL_MARKET_GAP as implausible', () => {
    const v = modelVsMarket(60, 450, 'three_pointers')!
    expect(v.gap).toBeGreaterThan(MAX_MODEL_MARKET_GAP)
    expect(v.plausible).toBe(false)
    const w = modelVsMarket(60, -110, 'points')!
    expect(w.plausible).toBe(w.gap <= MAX_MODEL_MARKET_GAP)
  })

  it('returns null without usable odds', () => {
    expect(modelVsMarket(60, null, 'points')).toBeNull()
    expect(modelVsMarket(60, 3000, 'points')).toBeNull()
  })
})
