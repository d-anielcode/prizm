/**
 * lib/calibration.ts — Isotonic-fit raw->calibrated score map.
 *
 * Built by scripts/build_calibration.py (fits sklearn IsotonicRegression on
 * prop_grades). Module 4 of model_diagnostic.py shows raw scores 65-80 are
 * 9-14pp overconfident — this remap produces honest probabilities so a
 * displayed "70" actually means "70% historical hit rate".
 *
 * ## Architecture
 *
 * Stored `confidence_score` in the DB is ALWAYS RAW. This file's
 * `applyCalibration()` is used only at *display* time (UI components, API
 * response shaping, performance bucketing). Tier label (LOCK/PLAY/LEAN/FADE),
 * sorting, dedup, and parlay pool selection still operate on raw scores.
 *
 * Why raw-stored + calibrated-displayed:
 *   1. No DB migration — historical and future rows live on one scale.
 *   2. The calibration table can be re-fit weekly without rewriting any data.
 *   3. Internal logic (which depends on raw-score resolution at the top tier)
 *      is unaffected by the isotonic plateaus.
 *   4. Users see honest probabilities — a "65 LOCK" means 65% historical
 *      hit rate, not a raw score that happens to hit at 58%.
 *
 * ## Usage
 *
 *   import { applyCalibration } from '@/lib/calibration'
 *   const honestPct = Math.round(applyCalibration(prop.confidence_score))
 *
 * Safe to import from both server and client components — the JSON table
 * is statically imported at compile time, no filesystem access.
 */

import calibrationTable from '@/lib/calibration-table.json'

interface CalibrationTable {
  version?:      string
  generated_at: string
  data_window:  { start: string; end: string; game_days: number; graded_props: number }
  /** Legacy global lookup — used as fallback when per-stat is missing. */
  lookup:       number[]
  /** v2+: per-stat-type lookups (101 entries each, indexed by raw score 0-100). */
  per_stat?:    Record<string, number[]>
  /** Sample counts behind each per-stat fit (for QA / "data window" UX). */
  sample_counts?: Record<string, number>
}

const TABLE = calibrationTable as CalibrationTable
const GLOBAL = TABLE.lookup
const PER_STAT = TABLE.per_stat ?? {}
const GLOBAL_VALID = Array.isArray(GLOBAL) && GLOBAL.length === 101

function interpolate(lookup: number[], rawScore: number): number {
  const x = Math.max(0, Math.min(100, rawScore))
  const lo = Math.floor(x)
  const hi = Math.min(100, lo + 1)
  if (lo === hi) return lookup[lo]
  const frac = x - lo
  return lookup[lo] * (1 - frac) + lookup[hi] * frac
}

/**
 * Map a raw confidence score (0-100) to its historically-calibrated hit rate
 * (also 0-100). When `statType` is provided AND a per-stat table exists,
 * uses the per-stat curve — different stats have very different calibration
 * (e.g. rebounds at 75 = 90% historical, 3PM at 75 = 61%).
 *
 * Falls back to the global curve when statType is missing or has no per-stat
 * fit (e.g. stats with <500 graded samples). Falls back to raw score if the
 * whole table is malformed.
 *
 * Linear-interpolated between integer grid points; clamped to [0, 100].
 */
export function applyCalibration(rawScore: number, statType?: string): number {
  if (statType && PER_STAT[statType]?.length === 101) {
    return interpolate(PER_STAT[statType], rawScore)
  }
  if (GLOBAL_VALID) return interpolate(GLOBAL, rawScore)
  return rawScore
}

/** Round helper for display — applyCalibration + Math.round in one call. */
export function calibratedPct(
  rawScore: number | null | undefined,
  statType?: string,
): number | null {
  if (rawScore == null) return null
  return Math.round(applyCalibration(rawScore, statType))
}

/** Metadata about the calibration fit, for "trained on N props from X to Y" UX. */
export function calibrationMeta() {
  return {
    version:       TABLE.version ?? 'v1-global',
    generated_at:  TABLE.generated_at,
    window:        TABLE.data_window,
    valid:         GLOBAL_VALID,
    per_stat_keys: Object.keys(PER_STAT),
    sample_counts: TABLE.sample_counts ?? {},
  }
}

/** True when a per-stat lookup is available for this stat type. */
export function hasPerStatCalibration(statType: string): boolean {
  return PER_STAT[statType]?.length === 101
}
