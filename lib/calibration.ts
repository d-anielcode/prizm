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
  generated_at: string
  data_window:  { start: string; end: string; game_days: number; graded_props: number }
  lookup:       number[]
}

const TABLE = calibrationTable as CalibrationTable
const LOOKUP = TABLE.lookup
const VALID = Array.isArray(LOOKUP) && LOOKUP.length === 101

/**
 * Map a raw confidence score (0-100) to its historically-calibrated hit rate
 * (also 0-100). Linear-interpolated between integer grid points; clamped to
 * [0, 100]. Returns the input untouched if the calibration table is missing
 * or malformed — fail-safe behavior.
 *
 * Example: if isotonic learned that raw=72.5 corresponds to 58.2% actual,
 * applyCalibration(72.5) ≈ 58.2.
 */
export function applyCalibration(rawScore: number): number {
  if (!VALID) return rawScore
  const x = Math.max(0, Math.min(100, rawScore))
  const lo = Math.floor(x)
  const hi = Math.min(100, lo + 1)
  if (lo === hi) return LOOKUP[lo]
  const frac = x - lo
  return LOOKUP[lo] * (1 - frac) + LOOKUP[hi] * frac
}

/** Round helper for display — applyCalibration + Math.round in one call. */
export function calibratedPct(rawScore: number | null | undefined): number | null {
  if (rawScore == null) return null
  return Math.round(applyCalibration(rawScore))
}

/** Metadata about the calibration fit, for "trained on N props from X to Y" UX. */
export function calibrationMeta() {
  return {
    generated_at: TABLE.generated_at,
    window:       TABLE.data_window,
    valid:        VALID,
  }
}
