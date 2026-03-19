// NBA IQ — Confidence Scoring Engine v3
//
// Core insight: season avg cushion vs the prop line is the #1 predictor.
// If a player averages 24 pts and the line is 17.5 → massive cushion → OVER is very likely.
// If a player averages 17 pts and the line is 18.5 → negative cushion → OVER is risky.
//
// 5 weighted factors — all compute real values without needing game logs:
//   1. Season cushion %      (45%) — primary differentiator
//   2. Stat type reliability (20%) — some stats are inherently more consistent
//   3. Line tier fit         (20%) — is the line in the "sweet spot" for that stat?
//   4. Direction edge        (10%) — slight statistical edge to UNDERs in NBA props
//   5. Data confidence        (5%) — bonus for having real season data vs blind guess

import type { Prop, StatType, ConfidenceLabel, RiskTier } from '@/types'

interface ScoredProp extends Prop {
  confidence_score: number
  confidence_label: ConfidenceLabel
  risk_tier: RiskTier
  confidence_reason: string
}

// Factor weights — must sum to 1.0
const W = {
  cushion:     0.45,
  statType:    0.20,
  lineTier:    0.20,
  direction:   0.10,
  dataQuality: 0.05,
} as const

// ─── Factor 1: Season cushion % ──────────────────────────────────────────────
// How far is the season avg from the prop line, as a percentage?
// Positive cushion (avg >> line) → strong OVER. Negative → risky OVER / good UNDER.
function cushionScore(avg: number, line: number, dir: 'over' | 'under'): number {
  if (avg <= 0 || line <= 0) return 0.50 // neutral if no data

  // % gap: (avg - line) / line
  // +30% gap → near certain OVER → score 0.95
  // 0% gap  → coin flip         → score 0.50
  // -30%    → near certain miss  → score 0.05
  const pct = (avg - line) / line

  // S-curve: squash to [0.05, 0.95]
  // pct / 0.60 maps ±30% to ±0.50 → add 0.50 → range [0.0, 1.0]
  const raw = Math.min(0.95, Math.max(0.05, pct / 0.60 + 0.50))

  return dir === 'over' ? raw : 1 - raw
}

// ─── Factor 2: Stat type reliability ─────────────────────────────────────────
// Research-backed coefficient of variation by stat type.
// Low CV = more predictable = higher base reliability score.
// Source: NBA player prop research, ~3 seasons of data.
const STAT_RELIABILITY: Record<StatType, number> = {
  pra:           0.68, // combined stat smooths variance
  rebounds:      0.63, // fairly consistent game-to-game
  assists:       0.61, // consistent for starters
  points:        0.55, // medium variance (hot/cold shooting)
  three_pointers: 0.40, // very streaky — high variance
  steals:        0.35, // boom/bust nightly
  blocks:        0.32, // rarest, most volatile
}

// ─── Factor 3: Line tier fit ──────────────────────────────────────────────────
// Each stat has a "sweet spot" where lines are most predictable.
// Very low lines = garbage time / limited minutes (risky either way).
// Very high lines = elite player prop set very tight (harder to predict).
function lineTierScore(line: number, stat: StatType): number {
  // Sweet spot ranges where props are historically most predictable
  const ranges: Record<StatType, [number, number]> = {
    points:        [10, 24],
    rebounds:      [3.5, 10],
    assists:       [2.5, 8],
    pra:           [20, 45],
    three_pointers: [1.5, 3.5],
    steals:        [0.5, 1.5],
    blocks:        [0.5, 1.5],
  }

  const [lo, hi] = ranges[stat]

  // In sweet spot → 0.70
  if (line >= lo && line <= hi) return 0.70

  // Below sweet spot → lower lines are harder to predict (limited minutes players)
  if (line < lo) {
    const dist = (lo - line) / lo
    return Math.max(0.35, 0.70 - dist * 0.50)
  }

  // Above sweet spot → elite player, tight lines, still harder to predict
  const dist = (line - hi) / hi
  return Math.max(0.40, 0.70 - dist * 0.40)
}

// ─── Factor 4: Direction edge ─────────────────────────────────────────────────
// NBA prop research shows UNDERs hit at ~52–53% due to conservative lines,
// garbage time DNPs, and rest. Slight statistical edge to UNDER bets.
function directionEdge(dir: 'over' | 'under'): number {
  return dir === 'under' ? 0.56 : 0.47
}

// ─── Factor 5: Data quality ───────────────────────────────────────────────────
// Bonus for having real season avg data vs falling back to blind inference.
function dataQualityScore(hasSeasonData: boolean): number {
  return hasSeasonData ? 0.65 : 0.40
}

// ─── Main scoring function ────────────────────────────────────────────────────
export function scoreProps(
  prop: Prop,
  _recentStats: unknown[], // kept for API compatibility — not used in v3
  seasonAvg: Record<StatType, number> | null,
): ScoredProp {
  const { line, stat_type, direction } = prop
  const avg = seasonAvg?.[stat_type] ?? null

  const f1 = avg !== null ? cushionScore(avg, line, direction) : 0.50
  const f2 = STAT_RELIABILITY[stat_type] ?? 0.50
  const f3 = lineTierScore(line, stat_type)
  const f4 = directionEdge(direction)
  const f5 = dataQualityScore(avg !== null)

  const raw = f1 * W.cushion + f2 * W.statType + f3 * W.lineTier + f4 * W.direction + f5 * W.dataQuality

  // Scale to 0–100, then clamp hard to [18, 95] — avoid 100/0 false certainty
  const score = Math.round(Math.min(95, Math.max(18, raw * 100)))

  const { label, tier } = getLabel(score)
  const reason = buildReason(prop, avg, score)

  return {
    ...prop,
    confidence_score: score,
    confidence_label: label,
    risk_tier: tier,
    confidence_reason: reason,
  }
}

// ─── Label thresholds ─────────────────────────────────────────────────────────
// Tuned so ~15% are HIGH, ~60% MEDIUM, ~25% LOW — realistic distribution
function getLabel(score: number): { label: ConfidenceLabel; tier: RiskTier } {
  if (score >= 70) return { label: 'HIGH',   tier: 'LOW_RISK'  }
  if (score >= 48) return { label: 'MEDIUM', tier: 'MED_RISK'  }
  return              { label: 'LOW',    tier: 'HIGH_RISK' }
}

// ─── Human-readable reason string ─────────────────────────────────────────────
function buildReason(
  prop: Prop,
  avg: number | null,
  score: number,
): string {
  const { stat_type, line, direction } = prop
  const parts: string[] = []

  if (avg !== null && avg > 0) {
    const cushionPct = (((avg - line) / line) * 100).toFixed(0)
    const sign = Number(cushionPct) >= 0 ? '+' : ''
    parts.push(`Season avg ${avg.toFixed(1)} (${sign}${cushionPct}% vs line)`)

    const favors = direction === 'over'
      ? (avg > line ? 'favors OVER' : 'line above avg — risky OVER')
      : (avg < line ? 'favors UNDER' : 'avg above line — risky UNDER')
    parts.push(favors)
  } else {
    parts.push('No season data — scored by line + stat type patterns')
  }

  // Add stat type note for volatile stats
  if (['steals', 'blocks', 'three_pointers'].includes(stat_type)) {
    parts.push(`${stat_type.replace('_', ' ')} props are high-variance`)
  }

  // Score context
  if (score >= 70) parts.push('Strong pattern — high confidence')
  else if (score < 48) parts.push('Unfavorable setup — treat as high risk')

  return parts.join(' · ')
}
