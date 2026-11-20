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

import { outOfSampleBuckets, calibrationWindowEnd } from '../calibration'

describe('outOfSampleBuckets', () => {
  const buckets = [{ label: '50–54', min: 50, max: 54 }, { label: '55–59', min: 55, max: 59 }]
  // Regression: the Performance page bucketed ALL graded props, including the ones
  // the calibration was fitted on, so expected ~= actual by construction.
  it('only counts props graded after the calibration window', () => {
    const end = calibrationWindowEnd()
    const rows = [
      { confidence_score: 50, stat_type: 'points', hit: true, game_date: end },       // in-sample: excluded
      { confidence_score: 50, stat_type: 'points', hit: false, game_date: '2099-01-01' },
    ]
    const r = outOfSampleBuckets(rows, buckets)
    expect(r.after).toBe(end)
    expect(r.sampleSize).toBe(1)
    expect(r.buckets.reduce((n, b) => n + b.total, 0)).toBeLessThanOrEqual(1)
  })
})
