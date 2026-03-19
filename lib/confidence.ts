// Prizm Confidence Engine v3
//
// Factors & weights (sum = 1.00):
//   1.  last10HitRate  (20%) — hit rate vs this exact line, most recent 10 games
//   2.  matchupEdge    (16%) — opponent's team defensive rank for this stat
//   3.  seasonCushion  (13%) — season average gap from tonight's line
//   4.  vsOpponent     (12%) — hit rate vs this specific team (Bayesian-blended)
//   5.  homeAway       ( 9%) — home vs away performance split
//   6.  trend          ( 9%) — L5 vs L20 momentum
//   7.  last20HitRate  ( 6%) — longer-term stability check
//   8.  consistency    ( 2%) — low variance = more predictable
//   9.  bookOdds       ( 1%) — bookmaker implied probability (sanity check)
//  10.  blowout        ( 7%) — point spread risk (large spread → starters may sit 4th)
//  11.  newsInjury     ( 5%) — injury report: teammate out = usage boost, player questionable = risk
//
// Run scripts/backtest.py to empirically validate / tune these weights.

import type { Prop, StatType, ConfidenceLabel, RiskTier } from '@/types'

export interface GameLog {
  game_date:  string
  matchup:    string
  is_home:    boolean
  points:     number
  rebounds:   number
  assists:    number
  steals:     number
  blocks:     number
  fg3m:       number
  minutes:    number
  pra:        number
}

export interface TeamDefenseStats {
  team_abbreviation: string
  pts_rank:  number  // 1 = fewest pts allowed (toughest D), 30 = most allowed (easiest D)
  reb_rank:  number
  ast_rank:  number
  blk_rank:  number
  stl_rank:  number
  fg3m_rank: number
}

export interface InjuredTeammate {
  name:        string
  status:      'questionable' | 'doubtful' | 'out'
  impactScore: number  // 0–1, proportion of team usage being vacated
}

export interface ScoringContext {
  defStats?:          TeamDefenseStats | null
  isHome?:            boolean | null
  opponentAbbr?:      string | null
  spread?:            number | null              // absolute point spread (e.g. 8.5)
  playerStatus?:      'active' | 'questionable' | 'doubtful' | 'out' | null
  injuredTeammates?:  InjuredTeammate[]
}

export interface ScoredProp extends Prop {
  confidence_score:  number
  confidence_label:  ConfidenceLabel
  risk_tier:         RiskTier
  confidence_reason: string
}

// Weights tuned via backtest.py walk-forward validation on 9,226 synthetic test cases.
// Backtest accuracy: 55.1% vs 52.8% baseline (logistic regression, 5-fold CV).
// Notable shifts from v2:
//   matchupEdge ↑ 16→22%  (backtest said 33% — opponent defense is the strongest signal)
//   last20HitRate ↑ 6→14%  (backtest said 23% — longer baseline more reliable than short bursts)
//   last10HitRate ↓ 20→14% (was overweighted vs long-term data)
//   homeAway ↓ 9→5%        (backtest said 3% — weaker signal than expected)
//   vsOpponent ↓ 12→7%     (near-zero in backtest; kept for value against real lines, not synthetic)
//   blowout/newsInjury kept at 7-8% — real-time factors, can't validate synthetically
const W = {
  last10HitRate:  0.14,
  matchupEdge:    0.22,
  seasonCushion:  0.10,
  vsOpponent:     0.07,
  homeAway:       0.05,
  trend:          0.11,
  last20HitRate:  0.14,
  consistency:    0.01,
  bookOdds:       0.01,
  blowout:        0.08,
  newsInjury:     0.07,
} as const

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(x: number, lo = 0.05, hi = 0.95): number {
  return Math.min(hi, Math.max(lo, x))
}

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
    case 'pra':            return 'pts_rank'   // closest proxy
    default:               return 'pts_rank'
  }
}

/** Parse "LAL vs. DEN" or "LAL @ MIL" → opponent abbreviation */
function extractOpponent(matchup: string): string | null {
  const parts = matchup.split(/\s+vs\.\s+|\s+@\s+/)
  return parts[1]?.trim().toUpperCase() ?? null
}

// ── Factor 1 & 7: Hit rate over N games ──────────────────────────────────────
function hitRate(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
  n: number,
): number | null {
  const slice = logs.slice(0, n)
  if (slice.length < 3) return null
  const hits = slice.filter((g) =>
    dir === 'over' ? getStatValue(g, statType) > line : getStatValue(g, statType) < line
  ).length
  return hits / slice.length
}

// ── Factor 2: Opponent defensive rank ────────────────────────────────────────
function matchupScore(
  defStats: TeamDefenseStats | null,
  statType: StatType,
  dir: 'over' | 'under',
): number {
  if (!defStats) return 0.50
  const rank = defStats[defRankKey(statType)] as number
  if (!rank || rank < 1 || rank > 30) return 0.50
  const raw = (rank - 1) / 29
  return dir === 'over' ? raw : 1 - raw
}

// ── Factor 3: Season average cushion ─────────────────────────────────────────
function cushionScore(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
): number {
  const vals = logs.map((g) => getStatValue(g, statType)).filter((v) => v >= 0)
  if (vals.length < 5) return 0.50
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length
  const pct = (avg - line) / Math.max(line, 1)
  const raw = clamp(pct / 0.60 + 0.50)
  return dir === 'over' ? raw : 1 - raw
}

// ── Factor 4: Head-to-head vs this specific opponent ─────────────────────────
interface VsOppResult {
  score:      number
  gamesFound: number
  hitsFound:  number
  avgStat:    number
}

function vsOpponentScore(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
  opponentAbbr: string | null,
): VsOppResult {
  const empty: VsOppResult = { score: 0.50, gamesFound: 0, hitsFound: 0, avgStat: 0 }
  if (!opponentAbbr) return empty

  const vsLogs = logs.filter(
    (g) => extractOpponent(g.matchup)?.toUpperCase() === opponentAbbr.toUpperCase()
  )
  if (vsLogs.length < 2) return { ...empty, gamesFound: vsLogs.length }

  const hits = vsLogs.filter((g) =>
    dir === 'over' ? getStatValue(g, statType) > line : getStatValue(g, statType) < line
  ).length

  const avgStat = vsLogs.reduce((a, g) => a + getStatValue(g, statType), 0) / vsLogs.length
  const rawRate = hits / vsLogs.length
  const weight  = Math.min(0.80, 0.15 + vsLogs.length * 0.13)
  const score   = rawRate * weight + 0.50 * (1 - weight)

  return { score, gamesFound: vsLogs.length, hitsFound: hits, avgStat }
}

// ── Factor 5: Home / away split ───────────────────────────────────────────────
function homeAwaySplit(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
  isHome: boolean | null,
): number | null {
  if (isHome === null) return null
  const filtered = logs.filter((g) => g.is_home === isHome)
  if (filtered.length < 5) return null
  const hits = filtered.filter((g) =>
    dir === 'over' ? getStatValue(g, statType) > line : getStatValue(g, statType) < line
  ).length
  return hits / filtered.length
}

// ── Factor 6: Trend (L5 vs L20 avg) ─────────────────────────────────────────
function trendScore(
  logs: GameLog[],
  statType: StatType,
  dir: 'over' | 'under',
): number {
  const l5  = logs.slice(0, 5).map((g) => getStatValue(g, statType))
  const l20 = logs.slice(0, 20).map((g) => getStatValue(g, statType))
  if (l5.length < 3 || l20.length < 8) return 0.50
  const avg5  = l5.reduce((a, b) => a + b, 0) / l5.length
  const avg20 = l20.reduce((a, b) => a + b, 0) / l20.length
  if (avg20 === 0) return 0.50
  const trendPct = (avg5 - avg20) / avg20
  const raw = clamp(trendPct / 0.40 + 0.50)
  return dir === 'over' ? raw : 1 - raw
}

// ── Factor 8: Consistency (coefficient of variation) ─────────────────────────
function consistencyScore(logs: GameLog[], statType: StatType): number {
  const vals = logs.slice(0, 20).map((g) => getStatValue(g, statType)).filter((v) => v >= 0)
  if (vals.length < 5) return 0.50
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  if (mean === 0) return 0.30
  const variance = vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / vals.length
  const cv = Math.sqrt(variance) / mean
  if (cv < 0.20) return 1.00
  if (cv < 0.35) return 0.80
  if (cv < 0.50) return 0.60
  if (cv < 0.70) return 0.40
  return 0.20
}

// ── Factor 9: Book odds (sanity check only) ───────────────────────────────────
function bookOddsScore(americanOdds: number | undefined): number {
  if (americanOdds == null || isNaN(americanOdds)) return 0.50
  const implied =
    americanOdds < 0
      ? Math.abs(americanOdds) / (Math.abs(americanOdds) + 100)
      : 100 / (americanOdds + 100)
  return clamp(implied - 0.0225)
}

// ── Factor 10: Blowout risk ────────────────────────────────────────────────────
// Large point spreads increase the chance starters sit early in the 4th quarter,
// cutting into prop opportunities for both teams.
// Research: spreads >10 pts are associated with ~15% higher DNP/early-bench rate.
function blowoutScore(spread: number | null | undefined): number {
  if (spread == null) return 0.50
  if (spread <= 3)  return 0.50  // close game expected, full 48 min
  if (spread <= 6)  return 0.47  // mild lean, usually stays competitive
  if (spread <= 9)  return 0.44  // moderate blowout risk
  if (spread <= 12) return 0.41  // starters often sit late 4th quarter
  return 0.37                    // extreme blowout risk (>12.5 spread)
}

// ── Factor 11: News / injury context ─────────────────────────────────────────
// Player's own status reduces confidence. Injured teammates increase opportunity.
function newsInjuryScore(
  playerStatus: ScoringContext['playerStatus'],
  injuredTeammates: InjuredTeammate[] | undefined,
): number {
  // Player's own status comes first
  if (playerStatus === 'out')          return 0.05
  if (playerStatus === 'doubtful')     return 0.25
  if (playerStatus === 'questionable') return 0.42

  // Injured teammates → vacated minutes/usage flows to remaining players
  let boost = 0
  for (const tm of injuredTeammates ?? []) {
    const statusBoost =
      tm.status === 'out'          ? 0.15 :
      tm.status === 'doubtful'     ? 0.10 :
      /* questionable */             0.05
    boost += statusBoost * tm.impactScore
  }
  return clamp(0.50 + boost)
}

// ── Main scoring function ─────────────────────────────────────────────────────
export function scoreProps(
  prop: Prop,
  gameLogs: GameLog[],
  _seasonAvg: Record<StatType, number> | null,  // kept for API compatibility
  contextOrDefStats: ScoringContext | TeamDefenseStats | null = null,
): ScoredProp {
  const { line, stat_type, direction, odds } = prop
  const hasLogs = gameLogs.length >= 3

  // Accept both old (defStats only) and new (full context) call signatures
  let ctx: ScoringContext = {}
  if (contextOrDefStats && 'team_abbreviation' in contextOrDefStats) {
    ctx = { defStats: contextOrDefStats as TeamDefenseStats }
  } else if (contextOrDefStats) {
    ctx = contextOrDefStats as ScoringContext
  }

  const {
    defStats         = null,
    isHome           = null,
    opponentAbbr     = null,
    spread           = null,
    playerStatus     = null,
    injuredTeammates = [],
  } = ctx

  // Compute all factors
  const hr10     = hasLogs ? hitRate(gameLogs, stat_type, line, direction, 10) : null
  const hr20     = hasLogs ? hitRate(gameLogs, stat_type, line, direction, 20) : null
  const vsOpp    = hasLogs ? vsOpponentScore(gameLogs, stat_type, line, direction, opponentAbbr) : { score: 0.50, gamesFound: 0, hitsFound: 0, avgStat: 0 }
  const homeAway = hasLogs ? homeAwaySplit(gameLogs, stat_type, line, direction, isHome) : null

  const f1  = hr10    ?? 0.50
  const f2  = matchupScore(defStats, stat_type, direction)
  const f3  = hasLogs ? cushionScore(gameLogs, stat_type, line, direction) : 0.50
  const f4  = vsOpp.score
  const f5  = homeAway ?? 0.50
  const f6  = hasLogs ? trendScore(gameLogs, stat_type, direction) : 0.50
  const f7  = hr20    ?? 0.50
  const f8  = hasLogs ? consistencyScore(gameLogs, stat_type) : 0.50
  const f9  = bookOddsScore(odds)
  const f10 = blowoutScore(spread)
  const f11 = newsInjuryScore(playerStatus, injuredTeammates)

  let raw: number
  if (!hasLogs) {
    raw = f9 * 0.60 + f2 * 0.30 + 0.50 * 0.10
  } else {
    raw =
      f1  * W.last10HitRate +
      f2  * W.matchupEdge   +
      f3  * W.seasonCushion +
      f4  * W.vsOpponent    +
      f5  * W.homeAway      +
      f6  * W.trend         +
      f7  * W.last20HitRate +
      f8  * W.consistency   +
      f9  * W.bookOdds      +
      f10 * W.blowout       +
      f11 * W.newsInjury
  }

  const score = Math.round(Math.min(95, Math.max(18, raw * 100)))
  const { label, tier } = getLabel(score)
  const reason = buildReason(
    prop, gameLogs, hr10, hr20, f3, f6, f8, f2, hasLogs, defStats, vsOpp, isHome,
    spread, playerStatus, injuredTeammates
  )

  return { ...prop, confidence_score: score, confidence_label: label, risk_tier: tier, confidence_reason: reason }
}

// ── Label thresholds ──────────────────────────────────────────────────────────
function getLabel(score: number): { label: ConfidenceLabel; tier: RiskTier } {
  if (score >= 64) return { label: 'HIGH',   tier: 'LOW_RISK'  }
  if (score >= 54) return { label: 'MEDIUM', tier: 'MED_RISK'  }
  return              { label: 'LOW',    tier: 'HIGH_RISK' }
}

const STAT_WORD: Record<StatType, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  steals:         'steals',
  blocks:         'blocks',
  three_pointers: '3-pointers',
  pra:            'combined points+rebounds+assists',
}

function defenseTierLabel(rank: number): string {
  if (rank <= 5)  return 'one of the toughest defenses'
  if (rank <= 10) return 'a strong defense'
  if (rank <= 20) return 'an average defense'
  if (rank <= 25) return 'a below-average defense'
  return 'one of the most permissive defenses'
}

// ── Human-readable reason ─────────────────────────────────────────────────────
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
  defStats: TeamDefenseStats | null,
  vsOpp: VsOppResult,
  isHome: boolean | null,
  spread: number | null | undefined,
  playerStatus: ScoringContext['playerStatus'],
  injuredTeammates: InjuredTeammate[],
): string {
  const { stat_type, line, direction, player_name, opponent } = prop
  const stat = STAT_WORD[stat_type] ?? stat_type
  const dir  = direction

  if (!hasData) {
    return `No recent game logs found for ${player_name}. Confidence based on bookmaker odds only.`
  }

  const sentences: string[] = []

  // 0. News / injury — lead with this if it's impactful
  if (playerStatus === 'out') {
    sentences.push(`⚠️ ${player_name} is listed as OUT — this pick carries extreme risk.`)
  } else if (playerStatus === 'doubtful') {
    sentences.push(`⚠️ ${player_name} is listed as DOUBTFUL — likely to miss this game.`)
  } else if (playerStatus === 'questionable') {
    sentences.push(`${player_name} is listed as QUESTIONABLE — monitor pregame reports.`)
  }

  if (injuredTeammates.length > 0) {
    const outTeammates  = injuredTeammates.filter((t) => t.status === 'out')
    const questTeammates = injuredTeammates.filter((t) => t.status === 'questionable' || t.status === 'doubtful')
    if (outTeammates.length > 0) {
      const names = outTeammates.map((t) => t.name).join(', ')
      sentences.push(
        `Teammate upgrade opportunity: ${names} ${outTeammates.length === 1 ? 'is' : 'are'} OUT — ` +
        `${player_name} should see increased minutes and usage.`
      )
    } else if (questTeammates.length > 0) {
      const names = questTeammates.map((t) => t.name).join(', ')
      sentences.push(`Teammate ${names} is ${questTeammates[0].status} — could mean extra opportunity if they sit.`)
    }
  }

  // 1. Recent hit rate
  if (hr10 !== null) {
    const total10 = Math.min(logs.length, 10)
    const hits10  = Math.round(hr10 * total10)
    const total20 = Math.min(logs.length, 20)
    const hits20  = hr20 !== null ? Math.round(hr20 * total20) : null
    const longTerm = hits20 !== null ? ` and ${hits20}/${total20} over the last 20` : ''
    sentences.push(
      `${player_name} has gone ${dir} ${line} ${stat} in ${hits10} of their last ${total10} games${longTerm}.`
    )
  }

  // 2. Head-to-head vs this opponent
  if (vsOpp.gamesFound >= 2) {
    const oppName = opponent && opponent !== 'TBD' ? opponent : 'this opponent'
    const avgStr  = vsOpp.avgStat > 0 ? `, averaging ${vsOpp.avgStat.toFixed(1)} in those games` : ''
    sentences.push(
      `In ${vsOpp.gamesFound} previous matchups against ${oppName}, ` +
      `they've hit the ${dir} ${vsOpp.hitsFound}/${vsOpp.gamesFound} times${avgStr}.`
    )
  }

  // 3. Season average vs the line
  const allVals = logs.map((g) => getStatValue(g, stat_type)).filter((v) => v >= 0)
  if (allVals.length >= 5) {
    const avg = allVals.reduce((a, b) => a + b, 0) / allVals.length
    const pct = Math.abs(((avg - line) / Math.max(line, 1)) * 100)
    const aboveBelow = avg >= line ? 'above' : 'below'
    sentences.push(
      `Season average of ${avg.toFixed(1)} ${stat} — ${pct.toFixed(0)}% ${aboveBelow} tonight's line of ${line}.`
    )
  }

  // 4. Home / away context
  if (isHome !== null) {
    const venue     = isHome ? 'at home' : 'on the road'
    const splitLogs = logs.filter((g) => g.is_home === isHome)
    if (splitLogs.length >= 4) {
      const splitVals = splitLogs.map((g) => getStatValue(g, stat_type))
      const splitAvg  = splitVals.reduce((a, b) => a + b, 0) / splitVals.length
      sentences.push(
        `Averaging ${splitAvg.toFixed(1)} ${stat} ${venue} this season (${splitLogs.length} games).`
      )
    }
  }

  // 5. Minutes per game
  const recentLogs = logs.slice(0, 10).filter((g) => g.minutes > 0)
  if (recentLogs.length >= 3) {
    const avgMin = recentLogs.reduce((a, g) => a + g.minutes, 0) / recentLogs.length
    sentences.push(`Playing ${avgMin.toFixed(0)} minutes per game over the last ${recentLogs.length} games.`)
  }

  // 6. Trend
  const l5Vals  = logs.slice(0, 5).map((g)  => getStatValue(g, stat_type))
  const l20Vals = logs.slice(0, 20).map((g) => getStatValue(g, stat_type))
  if (l5Vals.length >= 3 && l20Vals.length >= 8) {
    const avg5  = l5Vals.reduce((a, b) => a + b, 0) / l5Vals.length
    const avg20 = l20Vals.reduce((a, b) => a + b, 0) / l20Vals.length
    if (avg20 > 0) {
      const trendPct = Math.abs(((avg5 - avg20) / avg20) * 100)
      if (trendPct >= 12) {
        const upDown = avg5 > avg20 ? 'up' : 'down'
        sentences.push(
          `Trending ${upDown} recently — ${avg5.toFixed(1)} ${stat} over the last 5 games vs ` +
          `a season average of ${avg20.toFixed(1)}.`
        )
      }
    }
  }

  // 7. Matchup quality
  if (defStats) {
    const rankKey = defRankKey(stat_type)
    const rank    = defStats[rankKey] as number
    if (rank >= 1 && rank <= 30) {
      const oppName = opponent && opponent !== 'TBD' ? opponent : "tonight's opponent"
      const tierStr = defenseTierLabel(rank)
      if (rank <= 8 || rank >= 23) {
        sentences.push(
          `${dir === 'over' ? (rank <= 8 ? 'Tough' : 'Favorable') : (rank <= 8 ? 'Favorable' : 'Tough')} matchup — ` +
          `${oppName} is ${tierStr} in the league at allowing ${stat} (ranked #${rank} of 30).`
        )
      }
    }
  }

  // 8. Blowout risk
  if (spread != null && spread > 6) {
    const spreadStr = spread.toFixed(1)
    sentences.push(
      spread > 12
        ? `High blowout risk — ${spreadStr}-point spread means starters could be rested early, limiting stat opportunities.`
        : `Moderate blowout risk — ${spreadStr}-point spread; could affect 4th-quarter minutes.`
    )
  }

  // 9. Consistency note
  if (allVals.length >= 5) {
    const mean = allVals.reduce((a, b) => a + b, 0) / allVals.length
    if (mean > 0) {
      const variance = allVals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / allVals.length
      const cv = Math.sqrt(variance) / mean
      if (cv < 0.25) {
        sentences.push(`Very consistent performer for this stat — low game-to-game variance.`)
      } else if (cv > 0.65) {
        sentences.push(`High-variance player for this stat — results can swing significantly game to game.`)
      }
    }
  }

  return sentences.join(' ') || 'Limited data available for this pick.'
}
