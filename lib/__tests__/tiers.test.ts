import { describe, it, expect } from 'vitest'
import { pickTierThresholds } from '../calibration'
import { assignTier } from '../confidence'

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
  it('never resolves an underscore metadata key (_targets) as a stat lookup', () => {
    // Guards against a fractional target (0.6) leaking in as a raw threshold.
    expect(pickTierThresholds(TABLE, '_targets')).toEqual({ lock: 78, play: 73 }) // falls back to _global
  })
})

describe('assignTier', () => {
  it('LOCK at/above lock threshold', () => {
    expect(assignTier(80, 78, 73)).toEqual({ label: 'LOCK', tier: 'PRIME' })
  })
  it('PLAY between play and lock', () => {
    expect(assignTier(75, 78, 73)).toEqual({ label: 'PLAY', tier: 'LOW_RISK' })
  })
  it('FADE below play', () => {
    expect(assignTier(60, 78, 73)).toEqual({ label: 'FADE', tier: 'HIGH_RISK' })
  })
  it('never returns LEAN', () => {
    for (const s of [0, 50, 60, 73, 78, 90]) {
      expect(assignTier(s, 78, 73).label).not.toBe('LEAN')
    }
  })
  it('null lock falls through to PLAY (stat cannot earn LOCK)', () => {
    expect(assignTier(95, null, 77)).toEqual({ label: 'PLAY', tier: 'LOW_RISK' })
  })
})
