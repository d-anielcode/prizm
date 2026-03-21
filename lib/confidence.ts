// Prizm Confidence Engine v5
//
// Factors & weights (sum = 1.00):
//   1.  lineValue      (20%) — z-score of tonight's line vs player's L10 average + stdev [NEW]
//                              Measures whether the market has set a generous or tight line.
//                              Replaces last10HitRate which circularly applied tonight's line to past games.
//   2.  matchupEdge    (22%) — opponent's defensive rank for this stat
//   3.  last20HitRate  (15%) — did they beat this line in the last 20 games (longer-term stability)
//   4.  trend          (12%) — L5 vs L20 momentum
//   5.  pace           ( 7%) — game O/U total as pace proxy; more possessions = more counting stats [NEW]
//   6.  seasonCushion  ( 7%) — season average cushion above/below tonight's line
//   7.  newsInjury     ( 5%) — injury report: teammate out = usage boost, player Q = risk
//   8.  restDays       ( 5%) — back-to-back fatigue; well-rested boost
//   9.  blowout        ( 4%) — large spread = starters may sit 4th quarter
//  10.  homeAway       ( 2%) — home vs away performance split
//  11.  vsOpponent     ( 1%) — hit rate vs this specific team (Bayesian-blended)
//  12.  consistency    ( 0%) — removed: confirmed no predictive power in backtest
//
// HIGH threshold raised 65 → 73: fewer but higher-conviction picks.
// Consensus bonus/penalty: if 4+ of the 5 primary factors agree → +3pts; 0-1 agree → -10pts.
// Real-world result: 17/31 (55%) on first night with old model. Target: 70%+ on HIGH.

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

/** Actual line posted by a sportsbook for a specific game — from historical_prop_lines */
export interface HistoricalLine {
  game_date:  string
  stat_type:  string
  direction:  'over' | 'under'
  line:       number
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

export interface SeasonStats {
  avg_points:   number | null
  avg_rebounds: number | null
  avg_assists:  number | null
  avg_steals:   number | null
  avg_blocks:   number | null
  avg_fg3m:     number | null
  avg_pra:      number | null
  avg_minutes:  number | null
  games_played: number | null
}

export interface ScoringContext {
  defStats?:          TeamDefenseStats | null
  isHome?:            boolean | null
  opponentAbbr?:      string | null
  spread?:            number | null              // absolute point spread (e.g. 8.5)
  gameTotal?:         number | null              // over/under game total (e.g. 228.5) — pace proxy
  playerStatus?:      'active' | 'questionable' | 'doubtful' | 'out' | null
  injuredTeammates?:  InjuredTeammate[]
  seasonStats?:       SeasonStats | null
  historicalLines?:   HistoricalLine[]           // actual lines posted by books for past games
}

export interface ScoredProp extends Prop {
  confidence_score:  number
  confidence_label:  ConfidenceLabel
  risk_tier:         RiskTier
  confidence_reason: string
}

const W = {
  lineValue:      0.20,  // NEW: z-score of line vs L10 avg — real market value signal
  matchupEdge:    0.22,  // opponent defensive rank for this stat
  last20HitRate:  0.15,  // supplementary stability check (same recent games, not circular)
  trend:          0.12,  // L5 vs L20 momentum
  pace:           0.07,  // NEW: game O/U total → possession count proxy
  seasonCushion:  0.07,  // season average gap from the line
  newsInjury:     0.05,  // injury context
  restDays:       0.05,  // B2B fatigue / rest boost
  blowout:        0.04,  // large spread = early garbage time risk
  homeAway:       0.02,  // home vs away split
  vsOpponent:     0.01,  // h2h history (Bayesian-blended)
  consistency:    0.00,  // confirmed no predictive power
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

// ── Actual hit rate vs real posted lines ─────────────────────────────────────
// Unlike hitRate() which applies tonight's static line retroactively,
// this matches each game log to the actual line posted that night.
// Falls back to hitRate() for games where no historical line exists.
function actualHitRate(
  logs: GameLog[],
  historicalLines: HistoricalLine[],
  statType: StatType,
  dir: 'over' | 'under',
  n: number,
): number | null {
  const lineByDate = new Map<string, number>()
  for (const h of historicalLines) {
    if (h.stat_type === statType && h.direction === dir) {
      // Average line across books for this date (consensus line)
      const existing = lineByDate.get(h.game_date)
      lineByDate.set(h.game_date, existing != null ? (existing + h.line) / 2 : h.line)
    }
  }

  const slice = logs.slice(0, n)
  if (slice.length < 3) return null

  let matched = 0
  let hits = 0
  for (const log of slice) {
    const actualLine = lineByDate.get(log.game_date)
    if (actualLine == null) continue  // no historical line for this game — skip
    const stat = getStatValue(log, statType)
    if (dir === 'over' ? stat > actualLine : stat < actualLine) hits++
    matched++
  }

  return matched >= 3 ? hits / matched : null
}

// ── Factor 1 (NEW): Line value z-score ───────────────────────────────────────
// Measures whether the market line is generous or tight vs the player's recent form.
// Unlike hitRate() which applies tonight's line retroactively to past games (circular),
// this computes: how many standard deviations is the player's L10 avg above/below the line?
// A line set below a player's recent average (positive z for OVER) = genuine market value.
function lineValueScore(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
): number {
  const recent = logs.slice(0, 10).map((g) => getStatValue(g, statType)).filter((v) => v >= 0)
  if (recent.length < 5) return 0.50

  const mean = recent.reduce((a, b) => a + b, 0) / recent.length
  const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recent.length
  const stdev = Math.sqrt(variance)

  if (stdev < 0.5) return 0.50  // near-zero variance: no signal

  // For OVER: positive z = line is below recent avg = value (player likely to exceed)
  // For UNDER: positive z = line is above recent avg = value (player likely to fall short)
  const z = dir === 'over' ? (mean - line) / stdev : (line - mean) / stdev

  // z=1.5→0.92, z=1.0→0.78, z=0.5→0.64, z=0→0.50, z=-0.5→0.36, z=-1.0→0.22
  return clamp(0.50 + z * 0.28)
}

// ── Factor 13 (NEW): Pace / game total ────────────────────────────────────────
// Higher game O/U total = faster pace = more possessions = more counting stat opportunities.
// Applies strongest to points/assists/pra; weaker for rebounds/3PM; minimal for steals/blocks.
function paceScore(
  gameTotal: number | null | undefined,
  statType: StatType,
  dir: 'over' | 'under',
): number {
  if (!gameTotal || gameTotal < 185 || gameTotal > 280) return 0.50

  // How much counting stat volume scales with pace per stat type
  const paceRelevance: Partial<Record<StatType, number>> = {
    points:         1.0,
    assists:        0.9,
    pra:            0.9,
    rebounds:       0.6,
    three_pointers: 0.5,
    steals:         0.2,
    blocks:         0.2,
  }
  const relevance = paceRelevance[statType] ?? 0.5

  // NBA O/U totals typically 212–240. Mean ~226, sd ~8.
  const z = (gameTotal - 226) / 8
  const raw = 0.50 + z * 0.15 * relevance  // max ±15% effect for points
  return dir === 'over' ? clamp(raw) : clamp(1 - raw)
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
// Prefers true season average (from player_season_stats) over rolling log avg.
function cushionScore(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
  seasonStats: SeasonStats | null | undefined,
): number {
  // Use full-season average if available (more reliable than limited game logs)
  let avg: number | null = null
  if (seasonStats) {
    switch (statType) {
      case 'points':         avg = seasonStats.avg_points;   break
      case 'rebounds':       avg = seasonStats.avg_rebounds; break
      case 'assists':        avg = seasonStats.avg_assists;  break
      case 'steals':         avg = seasonStats.avg_steals;   break
      case 'blocks':         avg = seasonStats.avg_blocks;   break
      case 'three_pointers': avg = seasonStats.avg_fg3m;     break
      case 'pra':            avg = seasonStats.avg_pra;      break
    }
  }
  // Fall back to rolling game log average if no season stat
  if (avg == null) {
    const vals = logs.map((g) => getStatValue(g, statType)).filter((v) => v >= 0)
    if (vals.length < 5) return 0.50
    avg = vals.reduce((a, b) => a + b, 0) / vals.length
  }
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

// ── Factor 12: Rest days ──────────────────────────────────────────────────────
// Back-to-back games reduce performance ~3-4% in counting stats (published research).
// Computed from the most recent game log date vs tonight's tipoff time.
function restDaysScore(logs: GameLog[], commenceTime: string | undefined): number {
  if (!logs.length || !commenceTime) return 0.50
  const lastGame = new Date(logs[0].game_date)
  const tonight  = new Date(commenceTime)
  const rest = Math.round((tonight.getTime() - lastGame.getTime()) / 86400000) - 1
  if (rest <= 0)  return 0.25  // back-to-back: performance drops
  if (rest === 1) return 0.50  // 1 day rest: neutral
  if (rest === 2) return 0.60  // well-rested: slight boost
  return 0.55                   // 3+ days: well-rested but slight rust factor
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
    gameTotal        = null,
    playerStatus     = null,
    injuredTeammates = [],
    seasonStats      = null,
    historicalLines  = [],
  } = ctx

  // Compute all factors
  // Use actual historical lines when available; fall back to retroactive line application
  const hasHistoricalData = historicalLines.length >= 5
  const hr20 = hasLogs
    ? (hasHistoricalData
        ? (actualHitRate(gameLogs, historicalLines, stat_type, direction, 20) ?? hitRate(gameLogs, stat_type, line, direction, 20))
        : hitRate(gameLogs, stat_type, line, direction, 20))
    : null
  const vsOpp    = hasLogs ? vsOpponentScore(gameLogs, stat_type, line, direction, opponentAbbr) : { score: 0.50, gamesFound: 0, hitsFound: 0, avgStat: 0 }
  const homeAway = hasLogs ? homeAwaySplit(gameLogs, stat_type, line, direction, isHome) : null

  const fLineValue = hasLogs ? lineValueScore(gameLogs, stat_type, line, direction) : 0.50
  const f2  = matchupScore(defStats, stat_type, direction)
  const hasCushion = hasLogs || seasonStats != null
  const f3  = hasCushion ? cushionScore(gameLogs, stat_type, line, direction, seasonStats) : 0.50
  const f4  = vsOpp.score
  const f5  = homeAway ?? 0.50
  const f6  = hasLogs ? trendScore(gameLogs, stat_type, direction) : 0.50
  const f7  = hr20    ?? 0.50
  const f8  = hasLogs ? consistencyScore(gameLogs, stat_type) : 0.50
  const f10 = blowoutScore(spread)
  const f11 = newsInjuryScore(playerStatus, injuredTeammates)
  const f12 = restDaysScore(gameLogs, prop.commence_time)
  const fPace = paceScore(gameTotal, stat_type, direction)

  let raw: number
  if (!hasLogs) {
    // No game logs: rely on matchup + season cushion + injury context
    if (seasonStats != null) {
      raw = f2 * 0.50 + f3 * 0.30 + f11 * 0.20
    } else {
      raw = f2 * 0.70 + f11 * 0.30
    }
  } else {
    raw =
      fLineValue * W.lineValue      +
      f2         * W.matchupEdge    +
      f7         * W.last20HitRate  +
      f6         * W.trend          +
      fPace      * W.pace           +
      f3         * W.seasonCushion  +
      f11        * W.newsInjury     +
      f12        * W.restDays       +
      f10        * W.blowout        +
      f5         * W.homeAway       +
      f4         * W.vsOpponent     +
      f8         * W.consistency
  }

  // Consensus bonus/penalty: count how many of the 5 primary factors agree (≥0.55)
  // If only 1-2 agree, a single dominant factor is carrying the score — penalize.
  const primaryFactors = [fLineValue, f2, f7, f6, f3]
  const agreeCount = primaryFactors.filter((f) => f >= 0.55).length
  const consensusAdj = agreeCount >= 4 ? 3 : agreeCount >= 3 ? 0 : agreeCount >= 2 ? -4 : -10

  const score = Math.round(Math.min(95, Math.max(18, raw * 100 + consensusAdj)))
  const { label, tier } = getLabel(score)
  const reason = buildReason(
    prop, gameLogs, fLineValue, hr20, f3, f6, f8, f2, hasLogs, defStats, vsOpp, isHome,
    spread, playerStatus, injuredTeammates, seasonStats, gameTotal
  )

  return { ...prop, confidence_score: score, confidence_label: label, risk_tier: tier, confidence_reason: reason }
}

// ── Label thresholds ──────────────────────────────────────────────────────────
// v5 thresholds (raised from 65 to 73 for HIGH):
//   HIGH   (≥73): requires multiple independent factors agreeing — target 65%+ hit rate
//   MEDIUM (50–72): moderate confidence
//   LOW    (<50):  model leans against — the opposite direction may be the value
function getLabel(score: number): { label: ConfidenceLabel; tier: RiskTier } {
  if (score >= 73) return { label: 'HIGH',   tier: 'LOW_RISK'  }
  if (score >= 50) return { label: 'MEDIUM', tier: 'MED_RISK'  }
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
  lineValue: number,
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
  seasonStats: SeasonStats | null | undefined,
  gameTotal?: number | null,
): string {
  const { stat_type, line, direction, player_name, opponent } = prop
  const stat = STAT_WORD[stat_type] ?? stat_type
  const dir  = direction

  if (!hasData) {
    if (seasonStats) {
      let seasonAvg: number | null = null
      switch (stat_type) {
        case 'points':         seasonAvg = seasonStats.avg_points;   break
        case 'rebounds':       seasonAvg = seasonStats.avg_rebounds; break
        case 'assists':        seasonAvg = seasonStats.avg_assists;  break
        case 'steals':         seasonAvg = seasonStats.avg_steals;   break
        case 'blocks':         seasonAvg = seasonStats.avg_blocks;   break
        case 'three_pointers': seasonAvg = seasonStats.avg_fg3m;     break
        case 'pra':            seasonAvg = seasonStats.avg_pra;      break
      }
      const avgNote = seasonAvg != null
        ? ` Season average: ${seasonAvg.toFixed(1)} ${stat} (${seasonStats.games_played ?? '?'} GP).`
        : ''
      return `No recent game logs found for ${player_name}.${avgNote} Confidence based on season stats + matchup.`
    }
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

  // 1. Line value (market assessment)
  {
    const recent = logs.slice(0, 10).map((g) => getStatValue(g, stat_type)).filter((v) => v >= 0)
    if (recent.length >= 5) {
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length
      const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recent.length
      const stdev = Math.sqrt(variance)
      if (stdev >= 0.5) {
        const z = dir === 'over' ? (mean - line) / stdev : (line - mean) / stdev
        if (z >= 0.4) {
          const diff = Math.abs(mean - line).toFixed(1)
          const relWord = dir === 'over' ? 'below' : 'above'
          sentences.push(
            `Line value: the line of ${line} sits ${diff} ${relWord} their L10 average of ${mean.toFixed(1)} — the market has set this generously.`
          )
        } else if (z <= -0.4) {
          const diff = Math.abs(mean - line).toFixed(1)
          const relWord = dir === 'over' ? 'above' : 'below'
          sentences.push(
            `Tight line: the line of ${line} sits ${diff} ${relWord} their L10 average of ${mean.toFixed(1)} — the market has priced this aggressively.`
          )
        }
      }
    }
  }

  // 1b. Last 20 hit rate
  if (hr20 !== null) {
    const total20 = Math.min(logs.length, 20)
    const hits20  = Math.round(hr20 * total20)
    sentences.push(
      `${player_name} has gone ${dir} ${line} ${stat} in ${hits20} of their last ${total20} games.`
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

  // 3. Season average vs the line — prefer full season stats over rolling log avg
  let seasonAvgValue: number | null = null
  if (seasonStats) {
    switch (stat_type) {
      case 'points':         seasonAvgValue = seasonStats.avg_points;   break
      case 'rebounds':       seasonAvgValue = seasonStats.avg_rebounds; break
      case 'assists':        seasonAvgValue = seasonStats.avg_assists;  break
      case 'steals':         seasonAvgValue = seasonStats.avg_steals;   break
      case 'blocks':         seasonAvgValue = seasonStats.avg_blocks;   break
      case 'three_pointers': seasonAvgValue = seasonStats.avg_fg3m;     break
      case 'pra':            seasonAvgValue = seasonStats.avg_pra;      break
    }
  }
  // Fall back to rolling average from game logs
  if (seasonAvgValue == null) {
    const allVals = logs.map((g) => getStatValue(g, stat_type)).filter((v) => v >= 0)
    if (allVals.length >= 5) {
      seasonAvgValue = allVals.reduce((a, b) => a + b, 0) / allVals.length
    }
  }
  if (seasonAvgValue != null) {
    const pct = Math.abs(((seasonAvgValue - line) / Math.max(line, 1)) * 100)
    const aboveBelow = seasonAvgValue >= line ? 'above' : 'below'
    const gpNote = seasonStats?.games_played ? ` (${seasonStats.games_played} GP)` : ''
    sentences.push(
      `Season average of ${seasonAvgValue.toFixed(1)} ${stat}${gpNote} — ${pct.toFixed(0)}% ${aboveBelow} tonight's line of ${line}.`
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

  // 7b. Pace note
  if (gameTotal && gameTotal >= 185 && (stat_type === 'points' || stat_type === 'assists' || stat_type === 'pra')) {
    if (gameTotal >= 234) {
      sentences.push(`High-paced game expected (O/U ${gameTotal}) — more possessions means more ${stat} opportunities.`)
    } else if (gameTotal <= 215) {
      sentences.push(`Slow-paced game expected (O/U ${gameTotal}) — fewer possessions could limit ${stat} volume.`)
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
  const recentVals = logs.slice(0, 20).map((g) => getStatValue(g, stat_type)).filter((v) => v >= 0)
  if (recentVals.length >= 5) {
    const mean = recentVals.reduce((a, b) => a + b, 0) / recentVals.length
    if (mean > 0) {
      const variance = recentVals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recentVals.length
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
