// NBA IQ — Confidence Scoring Engine v2
// 4 factors, all computed from real NBA game log data.
// Removed: homeAway (hardcoded), lineMovement (placeholder), oppDefRank (all props had TBD opponent).
// Added: consistency (std dev), trend (last 5 vs prev 5 momentum), % cushion normalization.

import type { Prop, PlayerStat, ConfidenceLabel, RiskTier, StatType } from '@/types'

// Factor weights — must sum to 1.0
const WEIGHTS = {
  last10HitRate:  0.35, // Hit rate vs this exact line over last 10 games
  seasonCushion:  0.25, // Season avg % above/below line (% not absolute)
  consistency:    0.25, // Low std dev = predictable = trustworthy
  trend:          0.15, // Last 5 vs prior 5 — momentum signal
} as const

interface ScoredProp extends Prop {
  confidence_score: number
  confidence_label: ConfidenceLabel
  risk_tier: RiskTier
  confidence_reason: string
}

export function scoreProps(
  prop: Prop,
  recentStats: PlayerStat[],
  seasonAvg: Record<StatType, number> | null,
): ScoredProp {
  const line = prop.line
  const statKey = prop.stat_type
  const dir = prop.direction

  const vals = recentStats.map((g) => getStatValue(g, statKey))
  const last10 = vals.slice(0, 10)
  const last5  = vals.slice(0, 5)
  const prev5  = vals.slice(5, 10)

  // --- Factor 1: Last 10 hit rate (35%) ---
  // Require at least 3 games; else neutral 0.5
  let last10Score = 0.5
  if (last10.length >= 3) {
    const hits = last10.filter((v) => dir === 'over' ? v > line : v < line).length
    last10Score = hits / last10.length
  }

  // --- Factor 2: Season avg cushion % (25%) ---
  // Uses percentage difference so a 2pt gap on a 5pt line (40%) ≠ 2pt gap on 25pt line (8%)
  let cushionScore = 0.5
  if (seasonAvg) {
    const avg = seasonAvg[statKey] ?? 0
    if (avg > 0 && line > 0) {
      const pct = (avg - line) / line  // positive = avg above line
      // +20% above line → 1.0; at line → 0.5; -20% below line → 0.0
      const normalized = Math.min(1, Math.max(0, pct / 0.40 + 0.5))
      cushionScore = dir === 'over' ? normalized : 1 - normalized
    }
  }

  // --- Factor 3: Consistency / predictability (25%) ---
  // Low coefficient of variation = player is reliable = we can trust the projection
  let consistencyScore = 0.5
  if (last10.length >= 5) {
    const mean = last10.reduce((a, b) => a + b, 0) / last10.length
    if (mean > 0) {
      const variance = last10.reduce((sum, v) => sum + (v - mean) ** 2, 0) / last10.length
      const stdDev = Math.sqrt(variance)
      const cv = stdDev / mean  // coefficient of variation
      // CV <0.15 = very consistent (1.0); CV 0.15-0.30 = solid (0.75); CV 0.30-0.50 = moderate (0.5); CV >0.50 = boom/bust (0.2)
      if (cv < 0.15)       consistencyScore = 1.0
      else if (cv < 0.30)  consistencyScore = 0.75
      else if (cv < 0.50)  consistencyScore = 0.5
      else                 consistencyScore = 0.2
    }
  }

  // --- Factor 4: Trend / momentum (15%) ---
  // Compare last 5 avg vs prior 5 avg — is the player getting better or worse?
  let trendScore = 0.5
  if (last5.length >= 3 && prev5.length >= 3) {
    const last5Avg = last5.reduce((a, b) => a + b, 0) / last5.length
    const prev5Avg = prev5.reduce((a, b) => a + b, 0) / prev5.length
    if (prev5Avg > 0) {
      const trendPct = (last5Avg - prev5Avg) / prev5Avg  // positive = improving
      // +15% trend → 0.9; flat → 0.5; -15% trend → 0.1
      const normalized = Math.min(1, Math.max(0, trendPct / 0.30 + 0.5))
      trendScore = dir === 'over' ? normalized : 1 - normalized
    }
  }

  // --- Weighted sum → 0–100 score ---
  const raw =
    last10Score  * WEIGHTS.last10HitRate +
    cushionScore * WEIGHTS.seasonCushion +
    consistencyScore * WEIGHTS.consistency +
    trendScore   * WEIGHTS.trend

  const score = Math.round(raw * 100)

  const { label, tier } = getLabel(score)
  const reason = buildReason(prop, last10, last5, prev5, seasonAvg)

  return {
    ...prop,
    confidence_score: score,
    confidence_label: label,
    risk_tier: tier,
    confidence_reason: reason,
  }
}

function getLabel(score: number): { label: ConfidenceLabel; tier: RiskTier } {
  if (score >= 72) return { label: 'HIGH', tier: 'LOW_RISK' }
  if (score >= 52) return { label: 'MEDIUM', tier: 'MED_RISK' }
  return { label: 'LOW', tier: 'HIGH_RISK' }
}

function getStatValue(stat: PlayerStat, statType: StatType): number {
  switch (statType) {
    case 'points':        return stat.points
    case 'rebounds':      return stat.rebounds
    case 'assists':       return stat.assists
    case 'steals':        return stat.steals
    case 'blocks':        return stat.blocks
    case 'three_pointers': return stat.three_pointers
    case 'pra':           return stat.points + stat.rebounds + stat.assists
    default:              return 0
  }
}

function buildReason(
  prop: Prop,
  last10: number[],
  last5: number[],
  prev5: number[],
  seasonAvg: Record<StatType, number> | null,
): string {
  const parts: string[] = []
  const { stat_type, line, direction } = prop

  if (last10.length >= 3) {
    const hits = last10.filter((v) => direction === 'over' ? v > line : v < line).length
    const avg10 = (last10.reduce((a, b) => a + b, 0) / last10.length).toFixed(1)
    parts.push(`${hits}/${last10.length} last games ${direction} ${line}`)
    parts.push(`L10 avg ${avg10}`)
  }

  if (seasonAvg) {
    const avg = seasonAvg[stat_type]
    if (avg) {
      const cushion = (((avg - line) / line) * 100).toFixed(0)
      const sign = Number(cushion) >= 0 ? '+' : ''
      parts.push(`season avg ${avg.toFixed(1)} (${sign}${cushion}% vs line)`)
    }
  }

  if (last5.length >= 3 && prev5.length >= 3) {
    const l5 = (last5.reduce((a, b) => a + b, 0) / last5.length).toFixed(1)
    const p5 = (prev5.reduce((a, b) => a + b, 0) / prev5.length).toFixed(1)
    const trending = Number(l5) > Number(p5) ? '↑ trending up' : Number(l5) < Number(p5) ? '↓ trending down' : 'stable'
    parts.push(`L5 avg ${l5} vs L5-10 avg ${p5} ${trending}`)
  }

  if (last10.length >= 5) {
    const mean = last10.reduce((a, b) => a + b, 0) / last10.length
    const stdDev = Math.sqrt(last10.reduce((s, v) => s + (v - mean) ** 2, 0) / last10.length)
    if (stdDev < mean * 0.15) parts.push('very consistent')
    else if (stdDev > mean * 0.50) parts.push('high variance — boom/bust risk')
  }

  return parts.join(' · ') || 'Limited data — treat as speculative'
}
