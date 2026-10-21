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
