/**
 * lib/ev.ts — Expected value math for prop picks.
 *
 * The tier system (LOCK/PLAY/LEAN/FADE) ranks by raw confidence score, which
 * ignores odds. A LEAN at +150 can be better than a LOCK at -200 if the
 * probability advantage is large enough. EV puts everything on one scale.
 *
 * EV per unit stake = (calibrated_prob × decimal_odds) − 1
 *
 *   Positive  EV = profitable in expectation (the book is mispricing)
 *   Negative  EV = unprofitable in expectation (the juice eats the edge)
 *   Break-even at -110:  prob > 1/1.909 = 0.524
 *
 * All probabilities use the isotonic-calibrated score, NOT the raw model
 * score, because the calibrated value is "what fraction of these props
 * historically hit." That's the only honest input to EV.
 */

import { applyCalibration } from '@/lib/calibration'

/** Convert American odds to decimal. -110 -> 1.909, +120 -> 2.20 */
export function americanToDecimal(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds)) return null
  if (odds > 0)  return 1 + odds / 100
  if (odds < 0)  return 1 + 100 / Math.abs(odds)
  return null  // 0 odds is malformed
}

/** Implied probability from American odds (no overround removal). */
export function impliedProb(odds: number | null | undefined): number | null {
  const dec = americanToDecimal(odds)
  if (dec == null || dec <= 0) return null
  return 1 / dec
}

/**
 * Expected value per unit stake.
 * Returns null if either input is missing/invalid.
 *
 *   rawConfidenceScore: 0-100 from confidence.ts (RAW — we'll calibrate it)
 *   americanOdds: standard American odds (e.g. -110, +145)
 */
export function ev(rawConfidenceScore: number | null | undefined, americanOdds: number | null | undefined): number | null {
  if (rawConfidenceScore == null) return null
  const dec = americanToDecimal(americanOdds)
  if (dec == null) return null
  const prob = applyCalibration(rawConfidenceScore) / 100
  return prob * dec - 1
}

/** EV as a percentage, rounded to 1 decimal. Returns null if inputs invalid. */
export function evPct(rawConfidenceScore: number | null | undefined, americanOdds: number | null | undefined): number | null {
  const e = ev(rawConfidenceScore, americanOdds)
  if (e == null) return null
  return Math.round(e * 1000) / 10  // e.g. 0.0834 -> 8.3
}

/**
 * Break-even probability for the given American odds.
 * A prop is +EV iff calibrated_prob > breakEvenProb(odds).
 */
export function breakEvenProb(americanOdds: number | null | undefined): number | null {
  const dec = americanToDecimal(americanOdds)
  if (dec == null || dec <= 0) return null
  return 1 / dec
}
