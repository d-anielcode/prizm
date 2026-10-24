import { describe, it, expect } from 'vitest'
import { tierTargets } from '../calibration'
import table from '../calibration-table.json'

describe('tierTargets', () => {
  // Regression: Trends compared tiers to hard-coded 78% / 70% / 38% targets left
  // over from before the June 2026 calibration-derived tiers (LOCK 60%, PLAY 55%).
  it('reads the LOCK/PLAY targets the tiers are actually built on', () => {
    const t = (table as { tier_thresholds?: { _targets?: { lock: number; play: number } } }).tier_thresholds?._targets
    expect(tierTargets()).toEqual({ LOCK: t?.lock ?? 0.6, PLAY: t?.play ?? 0.55 })
  })
})
