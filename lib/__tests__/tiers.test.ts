import { describe, it, expect } from 'vitest'
import { pickTierThresholds } from '../calibration'

const TABLE = {
  tier_thresholds: {
    _targets: { lock: 0.6, play: 0.55 },
    _global: { lock: 78, play: 73 },
    rebounds: { lock: 76, play: 71 },
    three_pointers: { lock: null, play: 77 },
  },
}

describe('pickTierThresholds', () => {
  it('returns the per-stat entry when present', () => {
    expect(pickTierThresholds(TABLE, 'rebounds')).toEqual({ lock: 76, play: 71 })
  })
  it('falls back to _global when stat has no entry', () => {
    expect(pickTierThresholds(TABLE, 'points')).toEqual({ lock: 78, play: 73 })
  })
  it('preserves a deliberate null lock (stat cannot earn that tier)', () => {
    expect(pickTierThresholds(TABLE, 'three_pointers')).toEqual({ lock: null, play: 77 })
  })
  it('returns null when the table has no tier_thresholds block', () => {
    expect(pickTierThresholds({}, 'points')).toBeNull()
  })
})
