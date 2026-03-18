// NBA IQ — Confidence Scoring Engine
// The core algorithm. Each prop gets a score from 0–100 based on 6 weighted factors.
// PROTECTED: Do not modify without reviewing agent_docs/tech_stack.md first.

import type { Prop, PlayerStat, ConfidenceLabel, RiskTier, StatType } from '@/types'

// Factor weights — must sum to 1.0
const WEIGHTS = {
  last10HitRate: 0.30,    // How often player beat this exact line in last 10 games
  seasonAvgDiff: 0.20,    // Season avg vs. prop line
  oppDefRank: 0.20,       // Opponent defensive rank (30 = worst defense = favors over)
  homeAway: 0.10,         // Home/away performance split
  restDays: 0.10,         // Days since last game
  lineMovement: 0.10,     // Sharp money direction (placeholder: neutral 0.5)
} as const

interface ScoredProp extends Prop {
  confidence_score: number
  confidence_label: ConfidenceLabel
  risk_tier: RiskTier
  confidence_reason: string
}

// Main function: score a single prop given recent stats and season averages
export function scoreProps(
  prop: Prop,
  recentStats: PlayerStat[],        // Last 10 games
  seasonAvg: Record<StatType, number> | null,
  oppDefRank: number,               // 1–30 (30 = worst defense)
  isHome: boolean,
  daysSinceLastGame: number
): ScoredProp {
  const line = prop.line
  const statKey = prop.stat_type
  const dir = prop.direction

  // --- Factor 1: Last 10 hit rate (30%) ---
  let last10Score = 0.5 // default neutral if no data
  if (recentStats.length > 0) {
    const hits = recentStats.filter((g) => {
      const val = getStatValue(g, statKey)
      return dir === 'over' ? val > line : val < line
    }).length
    last10Score = hits / recentStats.length
  }

  // --- Factor 2: Season average vs. line (20%) ---
  let seasonScore = 0.5
  if (seasonAvg) {
    const avg = seasonAvg[statKey] ?? 0
    const diff = avg - line
    // Normalize: +5 over line = 1.0, -5 under = 0.0, at line = 0.5
    const normalized = Math.min(1, Math.max(0, (diff / 10) + 0.5))
    seasonScore = dir === 'over' ? normalized : 1 - normalized
  }

  // --- Factor 3: Opponent defensive rank (20%) ---
  // Rank 30 (worst D) = 1.0 score for over; Rank 1 (best D) = 0.0 for over
  const oppScore = dir === 'over'
    ? (oppDefRank - 1) / 29
    : 1 - (oppDefRank - 1) / 29

  // --- Factor 4: Home/Away split (10%) ---
  // Simple heuristic: home is slightly favored (0.55 home, 0.45 away)
  const homeAwayScore = isHome ? 0.6 : 0.4

  // --- Factor 5: Rest days (10%) ---
  // 0 days (B2B) = 0.2, 1 day = 0.4, 2 days = 0.6, 3+ days = 0.8
  let restScore = 0.5
  if (daysSinceLastGame === 0) restScore = 0.2
  else if (daysSinceLastGame === 1) restScore = 0.4
  else if (daysSinceLastGame === 2) restScore = 0.65
  else restScore = 0.8

  // --- Factor 6: Line movement (10%) ---
  // Placeholder: neutral 0.5 until we have historical line data
  const lineMovementScore = 0.5

  // --- Weighted sum → 0–100 score ---
  const raw =
    last10Score * WEIGHTS.last10HitRate +
    seasonScore * WEIGHTS.seasonAvgDiff +
    oppScore * WEIGHTS.oppDefRank +
    homeAwayScore * WEIGHTS.homeAway +
    restScore * WEIGHTS.restDays +
    lineMovementScore * WEIGHTS.lineMovement

  const score = Math.round(raw * 100)

  // --- Label & tier ---
  const { label, tier } = getLabel(score)

  // --- Plain English reason ---
  const reason = buildReason(prop, recentStats, seasonAvg, oppDefRank, daysSinceLastGame)

  return {
    ...prop,
    confidence_score: score,
    confidence_label: label,
    risk_tier: tier,
    confidence_reason: reason,
  }
}

function getLabel(score: number): { label: ConfidenceLabel; tier: RiskTier } {
  if (score >= 70) return { label: 'HIGH', tier: 'LOW_RISK' }
  if (score >= 45) return { label: 'MEDIUM', tier: 'MED_RISK' }
  return { label: 'LOW', tier: 'HIGH_RISK' }
}

function getStatValue(stat: PlayerStat, statType: StatType): number {
  switch (statType) {
    case 'points': return stat.points
    case 'rebounds': return stat.rebounds
    case 'assists': return stat.assists
    case 'steals': return stat.steals
    case 'blocks': return stat.blocks
    case 'three_pointers': return stat.three_pointers
    case 'pra': return stat.points + stat.rebounds + stat.assists
    default: return 0
  }
}

function buildReason(
  prop: Prop,
  recentStats: PlayerStat[],
  seasonAvg: Record<StatType, number> | null,
  oppDefRank: number,
  restDays: number
): string {
  const parts: string[] = []
  const { stat_type, line, direction } = prop

  if (recentStats.length > 0) {
    const vals = recentStats.map((g) => getStatValue(g, stat_type))
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length
    const hits = vals.filter((v) => direction === 'over' ? v > line : v < line).length
    parts.push(`${hits}/${recentStats.length} last games ${direction} ${line}`)
    parts.push(`avg ${avg.toFixed(1)} ${stat_type}`)
  }

  if (seasonAvg) {
    const avg = seasonAvg[stat_type]
    if (avg) parts.push(`season avg ${avg.toFixed(1)}`)
  }

  if (oppDefRank >= 25) parts.push(`vs weak defense (rank ${oppDefRank}/30)`)
  else if (oppDefRank <= 5) parts.push(`vs elite defense (rank ${oppDefRank}/30)`)

  if (restDays === 0) parts.push('back-to-back caution')
  else if (restDays >= 3) parts.push(`${restDays} days rest`)

  return parts.join(' · ') || 'Insufficient data for detailed analysis'
}
