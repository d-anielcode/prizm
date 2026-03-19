// NBA IQ — Confidence Scoring Engine v5 (AI Model)
//
// Multi-factor weighted model trained on NBA prop patterns.
// Primary data source: real game logs from stats.nba.com via nba_api.
//
// Factors (in priority order):
//   1. last10HitRate    (28%) — hit rate vs this exact line, last 10 games
//   2. seasonCushion    (20%) — season avg % above/below line
//   3. last20HitRate    (15%) — hit rate vs line, last 20 games (stability check)
//   4. trend            (12%) — last 5 avg vs last 20 avg (hot/cold streak)
//   5. consistency      (10%) — std dev / mean (lower = more predictable)
//   6. matchupEdge      (10%) — opponent's defensive rank for this stat type
//   7. bookOdds          (5%) — bookmaker implied probability (confirmation signal)
//
// Total = 100%. Book odds drop to 5% — they're a sanity check, not the signal.

import type { Prop, StatType, ConfidenceLabel, RiskTier } from '@/types'

export interface GameLog {
  game_date: string
  matchup: string
  is_home: boolean
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  fg3m: number
  minutes: number
  pra: number
}

export interface TeamDefenseStats {
  team_abbreviation: string
  pts_rank: number   // 1 = fewest pts allowed (toughest), 30 = most (easiest)
  reb_rank: number
  ast_rank: number
  blk_rank: number
  stl_rank: number
  fg3m_rank: number
}

export interface ScoredProp extends Prop {
  confidence_score: number
  confidence_label: ConfidenceLabel
  risk_tier: RiskTier
  confidence_reason: string
}

const W = {
  last10HitRate:  0.28,
  seasonCushion:  0.20,
  last20HitRate:  0.15,
  trend:          0.12,
  consistency:    0.10,
  matchupEdge:    0.10,
  bookOdds:       0.05,
} as const

// ─── Stat extraction ──────────────────────────────────────────────────────────
function getStatValue(log: GameLog, statType: StatType): number {
  switch (statType) {
    case 'points':         return log.points
    case 'rebounds':       return log.rebounds
    case 'assists':        return log.assists
    case 'steals':         return log.steals
    case 'blocks':         return log.blocks
    case 'three_pointers': return log.fg3m
    case 'pra':            return log.pra
    default:               return 0
  }
}

function defRankKey(statType: StatType): keyof TeamDefenseStats {
  switch (statType) {
    case 'points':         return 'pts_rank'
    case 'rebounds':       return 'reb_rank'
    case 'assists':        return 'ast_rank'
    case 'steals':         return 'stl_rank'
    case 'blocks':         return 'blk_rank'
    case 'three_pointers': return 'fg3m_rank'
    case 'pra':            return 'pts_rank' // closest proxy
    default:               return 'pts_rank'
  }
}

// ─── Factor 1 & 3: Hit rate over N games ─────────────────────────────────────
function hitRate(logs: GameLog[], statType: StatType, line: number, dir: 'over' | 'under', n: number): number | null {
  const slice = logs.slice(0, n)
  if (slice.length < 3) return null

  const vals = slice.map((g) => getStatValue(g, statType))
  const hits = vals.filter((v) => dir === 'over' ? v > line : v < line).length
  return hits / slice.length
}

// ─── Factor 2: Season avg cushion ────────────────────────────────────────────
function cushionScore(logs: GameLog[], statType: StatType, line: number, dir: 'over' | 'under'): number {
  const allVals = logs.map((g) => getStatValue(g, statType)).filter((v) => v > 0)
  if (allVals.length < 5) return 0.50

  const avg = allVals.reduce((a, b) => a + b, 0) / allVals.length
  const pct = (avg - line) / Math.max(line, 1) // % gap: positive = avg above line

  // S-curve: ±30% maps to [0.05, 0.95]
  const raw = Math.min(0.95, Math.max(0.05, pct / 0.60 + 0.50))
  return dir === 'over' ? raw : 1 - raw
}

// ─── Factor 4: Trend (last 5 vs last 20 avg) ─────────────────────────────────
function trendScore(logs: GameLog[], statType: StatType, dir: 'over' | 'under'): number {
  const last5  = logs.slice(0, 5).map((g) => getStatValue(g, statType))
  const last20 = logs.slice(0, 20).map((g) => getStatValue(g, statType))

  if (last5.length < 3 || last20.length < 8) return 0.50

  const avg5  = last5.reduce((a, b) => a + b, 0) / last5.length
  const avg20 = last20.reduce((a, b) => a + b, 0) / last20.length

  if (avg20 === 0) return 0.50
  const trendPct = (avg5 - avg20) / avg20  // positive = trending up

  // ±20% trend → maps to ±0.40 → centered at 0.50
  const raw = Math.min(0.95, Math.max(0.05, trendPct / 0.40 + 0.50))
  return dir === 'over' ? raw : 1 - raw
}

// ─── Factor 5: Consistency (std dev / mean) ───────────────────────────────────
function consistencyScore(logs: GameLog[], statType: StatType): number {
  const vals = logs.slice(0, 20).map((g) => getStatValue(g, statType)).filter((v) => v >= 0)
  if (vals.length < 5) return 0.50

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  if (mean === 0) return 0.30 // all zeros = uncertain

  const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length
  const cv = Math.sqrt(variance) / mean // coefficient of variation (lower = more consistent)

  // CV < 0.20 = very consistent (1.0), CV > 0.70 = boom/bust (0.2)
  if (cv < 0.20) return 1.00
  if (cv < 0.35) return 0.80
  if (cv < 0.50) return 0.60
  if (cv < 0.70) return 0.40
  return 0.20
}

// ─── Factor 6: Opponent defensive rank ───────────────────────────────────────
// rank 1 = hardest (fewest stat allowed) → lower score for OVER
// rank 30 = easiest (most stat allowed)  → higher score for OVER
function matchupScore(
  defStats: TeamDefenseStats | null,
  statType: StatType,
  dir: 'over' | 'under',
): number {
  if (!defStats) return 0.50

  const rank = defStats[defRankKey(statType)] as number
  if (!rank || rank < 1 || rank > 30) return 0.50

  // rank 1 → 0.03 (toughest matchup for OVER)
  // rank 15 → 0.50 (neutral)
  // rank 30 → 0.97 (easiest matchup for OVER)
  const raw = (rank - 1) / 29  // 0 to 1

  return dir === 'over' ? raw : 1 - raw
}

// ─── Factor 7: Book odds (confirmation only) ──────────────────────────────────
function bookOddsScore(americanOdds: number | undefined): number {
  if (americanOdds == null || isNaN(americanOdds)) return 0.50

  const implied =
    americanOdds < 0
      ? Math.abs(americanOdds) / (Math.abs(americanOdds) + 100)
      : 100 / (americanOdds + 100)

  // Remove ~half the standard 4.5% vig
  return Math.min(0.95, Math.max(0.05, implied - 0.0225))
}

// ─── Main scoring function ────────────────────────────────────────────────────
export function scoreProps(
  prop: Prop,
  gameLogs: GameLog[],
  seasonAvg: Record<StatType, number> | null,      // kept for API compat — derived from logs
  defStats: TeamDefenseStats | null = null,
): ScoredProp {
  const { line, stat_type, direction, odds } = prop
  const hasLogs = gameLogs.length >= 3

  // Compute all factors
  const hr10 = hasLogs ? hitRate(gameLogs, stat_type, line, direction, 10) : null
  const hr20 = hasLogs ? hitRate(gameLogs, stat_type, line, direction, 20) : null

  const f1 = hr10  ?? 0.50
  const f2 = hasLogs ? cushionScore(gameLogs, stat_type, line, direction) : 0.50
  const f3 = hr20  ?? 0.50
  const f4 = hasLogs ? trendScore(gameLogs, stat_type, direction) : 0.50
  const f5 = hasLogs ? consistencyScore(gameLogs, stat_type) : 0.50
  const f6 = matchupScore(defStats, stat_type, direction)
  const f7 = bookOddsScore(odds)

  const hasRealData = hasLogs

  // Weighted sum
  let raw =
    f1 * W.last10HitRate +
    f2 * W.seasonCushion +
    f3 * W.last20HitRate +
    f4 * W.trend +
    f5 * W.consistency +
    f6 * W.matchupEdge +
    f7 * W.bookOdds

  // If no real game log data: fall back to book odds as primary (v4 behavior)
  if (!hasRealData) {
    raw = bookOddsScore(odds) * 0.65 +
          (defStats ? matchupScore(defStats, stat_type, direction) * 0.20 : 0.10) +
          0.50 * 0.15
  }

  // Clamp to [18, 95] — avoid false certainty
  const score = Math.round(Math.min(95, Math.max(18, raw * 100)))
  const { label, tier } = getLabel(score)
  const reason = buildReason(prop, gameLogs, hr10, hr20, f2, f4, f5, f6, hasRealData)

  return { ...prop, confidence_score: score, confidence_label: label, risk_tier: tier, confidence_reason: reason }
}

// ─── Label thresholds ─────────────────────────────────────────────────────────
// HIGH  >= 68: strong multi-factor consensus
// MEDIUM 46–67: genuine uncertainty
// LOW   < 46:  stats actively work against this pick
function getLabel(score: number): { label: ConfidenceLabel; tier: RiskTier } {
  if (score >= 68) return { label: 'HIGH',   tier: 'LOW_RISK'  }
  if (score >= 46) return { label: 'MEDIUM', tier: 'MED_RISK'  }
  return              { label: 'LOW',    tier: 'HIGH_RISK' }
}

// ─── Human-readable reason ─────────────────────────────────────────────────────
function buildReason(
  prop: Prop,
  logs: GameLog[],
  hr10: number | null,
  hr20: number | null,
  cushion: number,
  trend: number,
  consistency: number,
  matchup: number,
  hasData: boolean,
): string {
  const { stat_type, line, direction } = prop
  const parts: string[] = []

  if (!hasData) {
    parts.push('No game logs yet — book odds used as fallback')
    return parts.join(' · ')
  }

  // Hit rate
  if (hr10 !== null) {
    const hits10 = Math.round(hr10 * Math.min(logs.length, 10))
    const total10 = Math.min(logs.length, 10)
    parts.push(`${hits10}/${total10} last games ${direction} ${line}`)
  }
  if (hr20 !== null) {
    const total20 = Math.min(logs.length, 20)
    const hits20 = Math.round(hr20 * total20)
    parts.push(`${hits20}/${total20} L20`)
  }

  // Season avg from game logs
  const allVals = logs.map((g) => {
    switch (stat_type) {
      case 'points': return g.points
      case 'rebounds': return g.rebounds
      case 'assists': return g.assists
      case 'steals': return g.steals
      case 'blocks': return g.blocks
      case 'three_pointers': return g.fg3m
      case 'pra': return g.pra
      default: return 0
    }
  }).filter((v) => v >= 0)
  if (allVals.length >= 5) {
    const avg = (allVals.reduce((a, b) => a + b, 0) / allVals.length).toFixed(1)
    const pct = (((Number(avg) - line) / line) * 100).toFixed(0)
    const sign = Number(pct) >= 0 ? '+' : ''
    parts.push(`Avg ${avg} (${sign}${pct}% vs line)`)
  }

  // Trend
  if (trend > 0.62) parts.push('↑ trending up')
  else if (trend < 0.38) parts.push('↓ trending down')

  // Consistency
  if (consistency >= 0.80) parts.push('very consistent')
  else if (consistency <= 0.40) parts.push('high variance')

  // Matchup
  if (matchup >= 0.70) parts.push('favorable matchup')
  else if (matchup <= 0.30) parts.push('tough matchup')

  return parts.join(' · ') || 'Limited data'
}
