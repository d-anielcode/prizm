// Prizm Confidence Engine v11.1
//
// v11.1 — Manual retune from diagnostic_report.json (71k graded props, 119 game days):
//   1. trend zeroed (was 0.01–0.07): AUC 0.490, corr -0.018, p=3e-6 over n=69,681 — anti-correlated.
//   2. restDays zeroed (was 0.01): AUC 0.496, p=0.279 — pure noise.
//   3. Freed weight (3–8 pp per stat) folded into last20HitRate.
//   4. Over-bias tightened on volatile stats:
//        three_pointers -3 → -7 (LOCK hit 48.9% on n=45 — worse than its own PLAY tier at 62.4%)
//        steals          -7 → -10 (under 61.7% vs over 42.7% — Δ19 pts)
//        blocks          -6 → -8  (under 56.3% vs over 44.0% — Δ12 pts)
//
// v11.0 (preserved for history):
//   1. Weights: trend halved (anti-correlated AUC 0.490), restDays dropped to 0.01 (p=0.279)
//      Freed weight redistributed to last20HitRate (60%) and homeAway (40%). All sets sum 1.00.
//   2. Over bias: stat-specific (steals -7, blocks -6, reb/ast/pra -4, pts/3PM -3)
//   3. LOCK thresholds raised: 3PM 72→76, assists 74→78, blocks 74→78. Base LOCK 72→74.
//   4. PLAY thresholds raised: 3PM 66→70, assists 68→72, blocks 72→74. Base PLAY 66→68.
//
// Factors & weights (sum = 1.00):
//   1.  lineValue      ( 2%) — z-score of tonight's line vs player's L10 average + stdev
//                              Only uses games within the last 60 days (date-windowed).
//   2.  matchupEdge    (14%) — opponent's defensive rank for this stat
//   3.  last20HitRate  (18%) — exponentially-weighted hit rate (recent games count more)
//                              Filtered to games within last 90 days.
//   4.  trend          (1-7%) — L5 vs L20 momentum (90-day window) — reduced in v11 (anti-correlated)
//   5.  seasonCushion  ( 2%) — season average cushion above/below tonight's line
//   6.  pace           ( 5%) — game O/U total as pace proxy — high-scoring games = more stats
//   7.  newsInjury     ( 9%) — injury report: teammate out = usage boost, player Q = risk
//   8.  restDays       ( 1%) — back-to-back fatigue (demoted in v11: no significant correlation)
//   9.  blowout        (11%) — large spread = starters may sit 4th quarter
//  10.  homeAway       (18%) — home vs away performance split (strongest signal with full history)
//  11.  vsOpponent     ( 4%) — hit rate vs this specific team (Bayesian-blended)
//
// Additive adjustments (not in weight sum):
//   - minutesTrendAdj:        ±2–3 pts if L5 minutes significantly above/below L20 baseline
//   - minutesUncertaintyPenalty: −4/−8 pts for fringe/bench players (avg < 24/20 min);
//                               additional −3 pts if minute variance stdev > 6 min.
//                               Prevents bench players from reaching LOCK/PLAY without dominant signal.
//   - overBiasAdj:            −3 to −10 pts for OVER props (stat-specific, v11.1).
//                               Steals −7, blocks −6, reb/ast/pra −4, pts/3PM −3.
//   - lineMovAdj:              ±2–6 pts for sharp money signal (line value movement vs pick direction)
//   - oddsMovAdj:              ±3–7 pts for odds movement (P(over) shift ≥3pp since morning snapshot)
//   - biasAdj:                 ±0–5 pts from player-specific historical over/under bias
//   - leakAdj:                 ±0–4 pts from opponent team defensive leak for this stat
//   - starBonus:               +3 pts for ≥36 min avg stars with generous line + hot hit rate
//   - consensusAdj:            +3/0/−4/−10 based on how many primary factors agree
//
// Data freshness: if a player's last game was >7 days ago, all log-based factor scores
// are compressed toward 0.50 proportionally. A 2-month absence = ~35% of signal retained.
// This prevents injury-return picks from scoring HIGH based on pre-injury form.
//
// Stat-specific weight sets: each stat has its own optimized weight object (W_POINTS, W_REBOUNDS, etc.).
// LOCK threshold: base 74 (stat-specific: assists/pra/steals/blocks ≥78, 3PM ≥76, rebounds ≥74).
// Star bonus: +3 pts for star players (≥36 min avg) with lineValue ≥0.58 + hitRate ≥0.55.

import type { Prop, StatType, ConfidenceLabel, RiskTier } from '@/types'
import { ABBR_TO_TEAM } from '@/lib/team-abbr'
import { readFileSync } from 'fs'
import { join } from 'path'

// ── Runtime weight config ────────────────────────────────────────────────────
// Reads from confidence-weights.json (written by auto_retrain.py).
// Falls back to hardcoded v11 defaults if file is missing or malformed.
interface WeightSet {
  lineValue: number; matchupEdge: number; last20HitRate: number; trend: number;
  seasonCushion: number; pace: number; newsInjury: number; restDays: number;
  blowout: number; homeAway: number; vsOpponent: number;
}
interface WeightConfig {
  version: string
  weights: Record<string, WeightSet>
  lock_thresholds: Record<string, number>
  play_thresholds: Record<string, number>
  base_lock_threshold: number
  base_play_threshold: number
  over_bias: Record<string, number>
  under_bias?: Record<string, number>  // optional — added 2026-05-14, falls back to UNDER_BIAS_DEFAULTS
}

let _cachedConfig: WeightConfig | null = null
let _configLoadedAt = 0
const CONFIG_TTL_MS = 5 * 60 * 1000  // re-read file every 5 minutes

function loadWeightConfig(): WeightConfig | null {
  const now = Date.now()
  if (_cachedConfig && (now - _configLoadedAt) < CONFIG_TTL_MS) return _cachedConfig
  try {
    const raw = readFileSync(join(process.cwd(), 'lib', 'confidence-weights.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed.weights && parsed.lock_thresholds && parsed.over_bias) {
      _cachedConfig = parsed as WeightConfig
      _configLoadedAt = now
      return _cachedConfig
    }
  } catch {
    // File missing or malformed — fall back to hardcoded defaults
  }
  return null
}

// Calibration helpers — see lib/calibration.ts. Re-exported here so existing
// imports keep working.
export { applyCalibration } from '@/lib/calibration'

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
  // Last-15-games ranks — more responsive to recent defensive form changes
  pts_rank_l15?:  number
  reb_rank_l15?:  number
  ast_rank_l15?:  number
  blk_rank_l15?:  number
  stl_rank_l15?:  number
  fg3m_rank_l15?: number
  // Team pace: possessions per 48 min (NBA avg ~100)
  pace?: number | null
}

export type PlayerPosition = 'guard' | 'forward' | 'center'

// Defense vs Position: allowed stats by position group (guard/forward/center)
export interface DvpStats {
  guard:   { pts: number; reb: number; ast: number; stl: number; blk: number; fg3m: number }
  forward: { pts: number; reb: number; ast: number; stl: number; blk: number; fg3m: number }
  center:  { pts: number; reb: number; ast: number; stl: number; blk: number; fg3m: number }
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

export interface PlayerLineBias {
  hit_rate:     number   // historical fraction of OVERs that hit for this player/stat
  median_ratio: number   // median(actual / line)
  sample_count: number   // number of games used
}

export interface OpponentStatLeak {
  over_hit_rate: number  // fraction of OVERs that hit against this opponent/stat
  median_ratio:  number  // median(actual / line) vs this opponent
  sample_count:  number  // number of games used
}

/** 3PM simulation result from Monte Carlo zone model */
export interface SimThreePm {
  p_over:   number  // probability of hitting over the line
  p_under:  number
  sim_mean: number  // average simulated 3PM
  sim_std:  number
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
  playerBias?:        PlayerLineBias | null      // systematic over/under bias for this player+stat
  opponentLeak?:      OpponentStatLeak | null    // team-specific defensive leak for this stat
  lineMovementDelta?: number | null              // current line − opening line (positive = line moved up)
  oddsMovementDelta?: number | null              // P(over) now − P(over) open (positive = sharp OVER money)
  // NEW factors
  dvpStats?:          DvpStats | null            // opponent defense broken down by player position
  playerPosition?:    PlayerPosition | null      // inferred player position (guard/forward/center)
  opponentOnB2B?:     boolean | null             // opponent played yesterday (fatigued defense)
  homePace?:          number | null              // home team pace (possessions/48)
  awayPace?:          number | null              // away team pace (possessions/48)
  simThreePm?:        SimThreePm | null          // Monte Carlo 3PM simulation result
  overHitRates?:      Map<string, number> | null // trailing 30-day over hit rate per stat type (for over-bias gate)
  underHitRates?:     Map<string, number> | null // trailing 30-day under hit rate per stat type (for under-bias gate)
  // Lineup confirmation (from confirmed_lineups, populated by /api/lineups/fetch)
  confirmedStarter?:  boolean | null             // true = confirmed/expected starter, false = on may-not-play list, null = no data
  lineupStatus?:      'confirmed' | 'expected' | 'projected' | 'unknown' | null
}

export interface ScoredProp extends Prop {
  confidence_score:  number
  confidence_label:  ConfidenceLabel
  risk_tier:         RiskTier
  confidence_reason: string
}

// ── Factor weights ────────────────────────────────────────────────────────────
// Per-stat weight sets derived from the per-stat weight optimizer (weight_optimizer.py).
// The optimizer runs 10k Dirichlet-sampled weight vectors per stat and finds the
// combination that maximises hit rate at the HIGH-confidence threshold.
// Active factors (lineValue, hitRate, trend, seasonCushion, restDays) have data-driven
// weights. Neutral factors (matchupEdge, pace, newsInjury, blowout, homeAway, vsOpponent)
// are always 0.50 in backtests so their weights are set by domain reasoning.
// All sets sum to 1.00.
//
// Key optimizer findings:
//   Points:   hitRate (0.26) + restDays (0.15) dominate; rest was severely underweighted
//   Rebounds: trend (0.15) > hitRate; matchupEdge less decisive than assumed
//   Assists:  seasonCushion (0.21) + trend (0.20) dominate; matchupEdge barely matters
//   Blocks:   seasonCushion (0.28) + trend (0.19) dominate (not matchupEdge)
//   Steals:   trend (0.24) + lineValue (0.13) dominate (not matchupEdge)
//   3PM:      hitRate (0.26) is the #1 signal — shooter streaks are highly predictive

// Points: hit rate + rest days dominate; rest was badly underweighted before.
//   last20HitRate ↑↑ — rolling prop hit rate is the most reliable active signal
//   restDays ↑↑     — rest-adjusted performance is a surprisingly strong predictor
//   matchupEdge ↑   — defensive matchup still meaningful for scoring
//   blowout ↑       — garbage time kills points props (blowout risk is real)
// Weights v11.1 — Manual retune zeroing trend + restDays based on diagnostic AUC.
// Predecessor: v11.0 (Apr 12 retrain), v7.0 PIT (point-in-time) Dirichlet search before that.
// trend (AUC 0.490 anti-correlated) and restDays (AUC 0.496 noise) both zeroed; freed
// 3–8 pp per stat folded into last20HitRate. All sets sum to 1.00.

// Points: last20HitRate dominant after v11.1 rebalance; trend+restDays zeroed.
const W_POINTS = {
  lineValue:      0.07,
  matchupEdge:    0.02,
  last20HitRate:  0.28,
  trend:          0.00,
  seasonCushion:  0.10,
  pace:           0.17,
  newsInjury:     0.13,
  restDays:       0.00,
  blowout:        0.08,
  homeAway:       0.13,
  vsOpponent:     0.02,
}

// Rebounds: homeAway confirmed dominant (5th consecutive run). trend+restDays zeroed in v11.1.
const W_REBOUNDS = {
  lineValue:      0.02,
  matchupEdge:    0.03,
  last20HitRate:  0.12,
  trend:          0.00,
  seasonCushion:  0.04,
  pace:           0.08,
  newsInjury:     0.13,
  restDays:       0.00,
  blowout:        0.04,
  homeAway:       0.52,
  vsOpponent:     0.02,
}

// Assists: seasonCushion dominates; vsOpponent confirmed strong. trend+restDays zeroed in v11.1.
const W_ASSISTS = {
  lineValue:      0.05,
  matchupEdge:    0.04,
  last20HitRate:  0.09,
  trend:          0.00,
  seasonCushion:  0.26,
  pace:           0.13,
  newsInjury:     0.09,
  restDays:       0.00,
  blowout:        0.06,
  homeAway:       0.12,
  vsOpponent:     0.16,
}

// PRA: seasonCushion + homeAway dominate composite totals. trend+restDays zeroed in v11.1.
const W_PRA = {
  lineValue:      0.04,
  matchupEdge:    0.07,
  last20HitRate:  0.06,
  trend:          0.00,
  seasonCushion:  0.25,
  pace:           0.02,
  newsInjury:     0.06,
  restDays:       0.00,
  blowout:        0.13,
  homeAway:       0.30,
  vsOpponent:     0.07,
}

// Blocks: seasonCushion dominant; matchupEdge meaningful via DVP. trend (was 0.07) + restDays zeroed in v11.1 — biggest single redistribution.
const W_BLOCKS = {
  lineValue:      0.02,
  matchupEdge:    0.13,
  last20HitRate:  0.19,
  trend:          0.00,
  seasonCushion:  0.25,
  pace:           0.06,
  newsInjury:     0.10,
  restDays:       0.00,
  blowout:        0.03,
  homeAway:       0.15,
  vsOpponent:     0.07,
}

// Steals: seasonCushion dominant; vsOpponent strong. trend+restDays zeroed in v11.1.
const W_STEALS = {
  lineValue:      0.11,
  matchupEdge:    0.03,
  last20HitRate:  0.16,
  trend:          0.00,
  seasonCushion:  0.29,
  pace:           0.10,
  newsInjury:     0.07,
  restDays:       0.00,
  blowout:        0.03,
  homeAway:       0.04,
  vsOpponent:     0.17,
}

// Three-pointers: matchupEdge strongest (DVP confirmed); homeAway elevated. trend+restDays zeroed in v11.1.
const W_THREE_POINTERS = {
  lineValue:      0.07,
  matchupEdge:    0.22,
  last20HitRate:  0.16,
  trend:          0.00,
  seasonCushion:  0.09,
  pace:           0.04,
  newsInjury:     0.06,
  restDays:       0.00,
  blowout:        0.07,
  homeAway:       0.25,
  vsOpponent:     0.04,
}

/** Pick the right weight set for the stat type */
function getWeights(statType: StatType): typeof W_POINTS {
  const config = loadWeightConfig()
  if (config?.weights[statType]) {
    return config.weights[statType] as typeof W_POINTS
  }
  if (statType === 'points')         return W_POINTS
  if (statType === 'rebounds')       return W_REBOUNDS
  if (statType === 'assists')        return W_ASSISTS
  if (statType === 'pra')            return W_PRA
  if (statType === 'blocks')         return W_BLOCKS
  if (statType === 'steals')         return W_STEALS
  if (statType === 'three_pointers') return W_THREE_POINTERS
  return W_POINTS  // safe default
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(x: number, lo = 0.05, hi = 0.95): number {
  return Math.min(hi, Math.max(lo, x))
}

/** Returns YYYY-MM-DD cutoff date N days before commenceTime. */
function dateCutoff(commenceTime: string | undefined, daysBack: number): string | null {
  if (!commenceTime) return null
  return new Date(new Date(commenceTime).getTime() - daysBack * 86400000)
    .toISOString().slice(0, 10)
}

// ── Data freshness ────────────────────────────────────────────────────────────
// Returns a multiplier (0–1) based on the gap between a player's most recent game
// and tonight. Applied to all log-derived factor deviations from 0.50, so a player
// returning from a long absence gets compressed toward neutral confidence.
//
//   Data-driven freshness decay (T8 research, April 2026):
//   Days 1-7:  hit rate ~0.478 (flat) → full weight
//   Days 8-14: hit rate ~0.43  (~5% drop) → mild decay
//   Days 15+:  hit rate ~0.37  (noisy, drops further) → stronger decay
//   Previous step function had a 12% cliff at day 8 — data only supports ~5%.
function dataFreshness(logs: GameLog[], commenceTime: string | undefined): number {
  if (!logs.length || !commenceTime) return 0.70
  const lastGame = new Date(logs[0].game_date)
  const tonight  = new Date(commenceTime)
  const gapDays  = (tonight.getTime() - lastGame.getTime()) / 86400000

  // Negative gap = last game is after commence time (data lag / timezone edge).
  // Treat as fresh — the player played very recently.
  if (gapDays <= 0) return 1.00

  if (gapDays > 90) return 0.15
  if (gapDays > 45) return 0.30
  if (gapDays > 21) return 0.50
  if (gapDays > 14) return 0.65
  if (gapDays > 7)  return 0.93  // was 0.88 — T8 data shows only ~5% drop, not 12%
  return 1.00
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

// Map StatType to DVP stat key
function dvpStatKey(statType: StatType): keyof DvpStats['guard'] {
  switch (statType) {
    case 'points':         return 'pts'
    case 'rebounds':       return 'reb'
    case 'assists':        return 'ast'
    case 'steals':         return 'stl'
    case 'blocks':         return 'blk'
    case 'three_pointers': return 'fg3m'
    case 'pra':            return 'pts'  // closest proxy
    default:               return 'pts'
  }
}

/**
 * Infer player position from season averages.
 * Centers: high rebounders (≥8) or shot-blockers (≥2)
 * Guards:  high assists (≥5.5) with lower rebounding (<5.5)
 * Forwards: everyone else
 */
export function inferPlayerPosition(seasonStats: SeasonStats | null | undefined): PlayerPosition {
  if (!seasonStats) return 'forward'
  const reb = seasonStats.avg_rebounds ?? 0
  const blk = seasonStats.avg_blocks ?? 0
  const ast = seasonStats.avg_assists ?? 0
  if (reb >= 8.0 || blk >= 2.0) return 'center'
  if (ast >= 5.5 && reb < 5.5) return 'guard'
  return 'forward'
}

/** Parse "LAL vs. DEN" or "LAL @ MIL" → opponent abbreviation */
function extractOpponent(matchup: string): string | null {
  const parts = matchup.split(/\s+vs\.\s+|\s+@\s+/)
  return parts[1]?.trim().toUpperCase() ?? null
}

// ── Factor 1 & 7: Hit rate over N games ──────────────────────────────────────
// Uses exponential decay weighting: most recent game has weight 1.0, each game
// back multiplied by 0.93 (game 10 back ≈ 0.48x weight). Also filters to games
// within the last 90 days so pre-injury/pre-season data doesn't pollute the rate.
function hitRate(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
  n: number,
  commenceTime?: string,
): number | null {
  const cutoff = dateCutoff(commenceTime, 90)
  const active = logs.filter((g) => g.minutes >= 5)
  const slice = (cutoff ? active.filter((g) => g.game_date >= cutoff) : active).slice(0, n)
  if (slice.length < 3) return null

  let weightedHits = 0
  let totalWeight   = 0
  for (let i = 0; i < slice.length; i++) {
    const w   = Math.pow(0.93, i)   // decay: game 0 = 1.0, game 10 ≈ 0.48
    const hit = dir === 'over'
      ? getStatValue(slice[i], statType) > line
      : getStatValue(slice[i], statType) < line
    weightedHits += hit ? w : 0
    totalWeight  += w
  }
  return weightedHits / totalWeight
}

// ── Actual hit rate vs real posted lines ─────────────────────────────────────
// Unlike hitRate() which applies tonight's static line retroactively,
// this matches each game log to the actual line posted that night.
// Also applies exponential weighting and 90-day filter, same as hitRate().
function actualHitRate(
  logs: GameLog[],
  historicalLines: HistoricalLine[],
  statType: StatType,
  dir: 'over' | 'under',
  n: number,
  commenceTime?: string,
): number | null {
  const lineByDate = new Map<string, number>()
  for (const h of historicalLines) {
    if (h.stat_type === statType && h.direction === dir) {
      const existing = lineByDate.get(h.game_date)
      lineByDate.set(h.game_date, existing != null ? (existing + h.line) / 2 : h.line)
    }
  }

  const cutoff = dateCutoff(commenceTime, 90)
  const active = logs.filter((g) => g.minutes >= 5)
  const slice = (cutoff ? active.filter((g) => g.game_date >= cutoff) : active).slice(0, n)
  if (slice.length < 3) return null

  let weightedHits = 0
  let totalWeight   = 0
  let matched       = 0
  for (let i = 0; i < slice.length; i++) {
    const actualLine = lineByDate.get(slice[i].game_date)
    if (actualLine == null) continue
    const w   = Math.pow(0.93, matched)  // weight by position among matched games
    const hit = dir === 'over'
      ? getStatValue(slice[i], statType) > actualLine
      : getStatValue(slice[i], statType) < actualLine
    weightedHits += hit ? w : 0
    totalWeight  += w
    matched++
  }

  return matched >= 3 ? weightedHits / totalWeight : null
}

// ── Factor 1: Line value z-score ─────────────────────────────────────────────
// Measures whether the market line is generous or tight vs the player's recent form.
// Only considers games within the last 60 days so injury-return players don't get
// a falsely bullish signal from pre-injury stats.
function lineValueScore(
  logs: GameLog[],
  statType: StatType,
  line: number,
  dir: 'over' | 'under',
  commenceTime?: string,
): number {
  const cutoff = dateCutoff(commenceTime, 60)
  const eligible = cutoff ? logs.filter((g) => g.game_date >= cutoff) : logs
  const recent = eligible.slice(0, 10).map((g) => getStatValue(g, statType)).filter((v) => v >= 0)
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

// ── Factor 13: Pace / game total ──────────────────────────────────────────────
// Uses actual team pace (possessions/48) when available; falls back to O/U total.
// Higher pace = more possessions = more counting stat opportunities.
function paceScore(
  gameTotal:  number | null | undefined,
  statType:   StatType,
  dir:        'over' | 'under',
  homePace?:  number | null,
  awayPace?:  number | null,
): number {
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

  // Prefer actual team pace when both teams' pace values are available
  if (homePace && awayPace && homePace > 85 && awayPace > 85) {
    const projectedPace = (homePace + awayPace) / 2
    // NBA pace typically 96–106 possessions/48 min, mean ~100, sd ~3
    const z = (projectedPace - 100) / 3
    const raw = 0.50 + z * 0.15 * relevance
    return dir === 'over' ? clamp(raw) : clamp(1 - raw)
  }

  // Fall back to O/U game total as pace proxy
  if (!gameTotal || gameTotal < 185 || gameTotal > 280) return 0.50
  // NBA O/U totals typically 212–240. Mean ~226, sd ~8.
  const z = (gameTotal - 226) / 8
  const raw = 0.50 + z * 0.15 * relevance
  return dir === 'over' ? clamp(raw) : clamp(1 - raw)
}

// ── Factor 2: Opponent defensive rank ─────────────────────────────────────────
// Blends season rank with L15 rank (60/40) for responsiveness.
// Also blends in positional DVP when player position is known (50/50).
function matchupScore(
  defStats:       TeamDefenseStats | null,
  statType:       StatType,
  dir:            'over' | 'under',
  dvpStats?:      DvpStats | null,
  playerPosition?: PlayerPosition | null,
): number {
  if (!defStats) return 0.50
  const seasonRank = defStats[defRankKey(statType)] as number
  if (!seasonRank || seasonRank < 1 || seasonRank > 30) return 0.50

  // Blend L15 rank with season rank: recent form matters more
  const l15Key = (defRankKey(statType) + '_l15') as keyof TeamDefenseStats
  const l15Rank = defStats[l15Key] as number | undefined
  const blendedRank = (l15Rank && l15Rank >= 1 && l15Rank <= 30)
    ? seasonRank * 0.40 + l15Rank * 0.60
    : seasonRank

  // Blend with DVP (positional defense) when player position is known
  let finalRank = blendedRank
  if (dvpStats && playerPosition) {
    const posGroup = dvpStats[playerPosition]
    if (posGroup) {
      const dvpRank = posGroup[dvpStatKey(statType)]
      if (dvpRank && dvpRank >= 1 && dvpRank <= 30) {
        // 50% blended season/L15 + 50% positional DVP
        finalRank = blendedRank * 0.50 + dvpRank * 0.50
      }
    }
  }

  const raw = (finalRank - 1) / 29
  // Clamp: L15/DVP blending can push finalRank outside [1,30] if source data is invalid
  return dir === 'over' ? clamp(raw) : clamp(1 - raw)
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
// Uses a 90-day window so pre-injury/last-season games don't distort the baseline.
// A player on a hot streak (high L5 vs L20) gets a positive trend score.
function trendScore(
  logs: GameLog[],
  statType: StatType,
  dir: 'over' | 'under',
  commenceTime?: string,
): number {
  const cutoff = dateCutoff(commenceTime, 90)
  const eligible = cutoff ? logs.filter((g) => g.game_date >= cutoff) : logs
  const l5  = eligible.slice(0, 5).map((g) => getStatValue(g, statType))
  const l20 = eligible.slice(0, 20).map((g) => getStatValue(g, statType))
  if (l5.length < 3 || l20.length < 8) return 0.50
  const avg5  = l5.reduce((a, b) => a + b, 0) / l5.length
  const avg20 = l20.reduce((a, b) => a + b, 0) / l20.length
  if (avg20 === 0) return 0.50
  const trendPct = (avg5 - avg20) / avg20
  const raw = clamp(trendPct / 0.40 + 0.50)
  return dir === 'over' ? raw : 1 - raw
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

// ── Player consistency / variance ────────────────────────────────────────────
// Coefficient of variation (CV = stdev / mean) on the last N stat outcomes.
// A player hitting 20 PTS with stdev 2 is far more reliable than a player
// hitting 20 PTS with stdev 8 — same line, same hit rate, very different bet.
// Low CV → boost high-tier confidence both ways (over and under both more
// predictable). High CV → suppress (avoid volatile players at LOCK).
//
// Returns a CV value (0..1+), or null if insufficient data.
// Used as an additive adjustment in scoreProps — NOT a tunable weight, so it
// doesn't require a retrain cycle to ship. Magnitudes capped at ±3 pts.
function consistencyCV(logs: GameLog[], statType: StatType): number | null {
  const recent = logs.slice(0, 10).filter((g) => g.minutes >= 5)
  if (recent.length < 5) return null
  const vals = recent.map((g) => {
    switch (statType) {
      case 'points':         return g.points
      case 'rebounds':       return g.rebounds
      case 'assists':        return g.assists
      case 'steals':         return g.steals
      case 'blocks':         return g.blocks
      case 'three_pointers': return g.fg3m
      case 'pra':            return g.pra
    }
  })
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length
  if (mean < 1) return null  // tiny means make CV unstable (e.g. blocks averaging 0.5)
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
  const stdev = Math.sqrt(variance)
  return stdev / mean
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

export type WeightsOverride = Partial<typeof W_POINTS>

export interface PrecomputedFactors {
  fLineValue:  number
  f2:          number   // matchupEdge
  f3:          number   // seasonCushion
  f4:          number   // vsOpponent
  f5:          number   // homeAway
  f6:          number   // trend
  f7:          number   // last20HitRate
  f10:         number   // blowout
  f11:         number   // newsInjury
  f12:         number   // restDays
  fPace:       number
  freshness:     number
  consensusAdj:  number
  starBonus:     number
  biasAdj:       number
  leakAdj:       number
  minutesTrendAdj: number  // ±2–3 pts based on L5 vs L20 minutes trend
  // Additives added 2026-05-20 to bring applyWeights into parity with
  // scoreProps's full additive chain. Previously these existed only in
  // scoreProps and the optimizer (which uses applyWeights) was tuning weights
  // against a stripped-down phantom model.
  lineMovAdj:                number  // ±2–6 pts on sharp line movement
  oddsMovAdj:                number  // ±3–7 pts on implied-prob shifts
  minutesUncertaintyPenalty: number  // -4 to -11 pts for bench/fringe players
  overBiasAdj:               number  // negative for OVERs when overs under-perform
  underBiasAdj:              number  // positive for UNDERs when unders out-perform
  opponentB2bAdj:            number  // ±2 if opponent on back-to-back
  simAdj:                    number  // ±2/4/6 from 3PM Monte Carlo sim
  consistencyAdj:            number  // ±3 from L10 CV (player reliability)
  lineupAdj:                 number  // +2 confirmed starter; -25 confirmed out
  hasLogs:     boolean
  statType:    StatType
  direction:   'over' | 'under'
  hit:         boolean  // did OVER actually hit?
}

/**
 * computeAdditives — single source of truth for the 14 score-time additives.
 *
 * BLOCKER fix 2026-05-20: previously these additives lived inline inside
 * scoreProps. Only 5 of them were stored on PrecomputedFactors, so applyWeights
 * (used by scripts/optimize-weights.ts) was summing a stripped-down phantom
 * model — and the optimizer was tuning factor weights against it. This
 * extraction guarantees both code paths score the same prop the same way.
 *
 * Inputs are the prop, raw game logs, full ScoringContext, and the 11
 * pre-computed factor values (passed in to avoid recomputing them). Returns
 * every additive used in the final sum, ready to be added to (adjustedRaw * 100).
 *
 * Keep in lockstep with the `score = Math.round(...)` line in scoreProps.
 * A parity test in lib/__tests__/confidence.test.ts asserts this.
 */
export interface ScoreAdditives {
  freshness:                 number  // multiplier on consensusAdj + on (raw - 0.5)
  consensusAdj:              number
  starBonus:                 number
  biasAdj:                   number
  leakAdj:                   number
  lineMovAdj:                number
  oddsMovAdj:                number
  minutesTrendAdj:           number
  minutesUncertaintyPenalty: number
  overBiasAdj:               number
  underBiasAdj:              number
  opponentB2bAdj:            number
  simAdj:                    number
  consistencyAdj:            number
  lineupAdj:                 number
}

export function computeAdditives(
  prop:       Prop,
  gameLogs:   GameLog[],
  ctx:        ScoringContext,
  factors:    { fLineValue: number; f2: number; f3: number; f4: number; f5: number; f6: number; f7: number; f10: number; f11: number; f12: number; fPace: number },
  playerTier: 'star' | 'starter' | 'rotation',
  hasLogs:    boolean,
): ScoreAdditives {
  const { line: _line, stat_type, direction } = prop
  void _line  // unused locally but kept for signature stability
  const ct = prop.commence_time
  const { fLineValue, f2, f3, f6, f7, f11 } = factors

  // freshness multiplier (used in adjustedRaw + applied to consensusAdj)
  const freshness = hasLogs ? dataFreshness(gameLogs, ct) : 1.00

  // Consensus among top 5 primary factors
  const primaryFactors = [fLineValue, f2, f7, f6, f3]
  const agreeCount = primaryFactors.filter((f) => f >= 0.55).length
  const consensusAdj = agreeCount >= 4 ? 3 : agreeCount >= 3 ? 0 : agreeCount >= 2 ? -4 : -10

  // Star bonus
  let starBonus = 0
  if (hasLogs && direction === 'over' && playerTier === 'star' && fLineValue >= 0.58 && f7 >= 0.55) {
    starBonus = 3
  }

  // Player line bias (mult=10, cap=±5 — see fb3bef6, 4c668fe)
  let biasAdj = 0
  if (ctx.playerBias && ctx.playerBias.sample_count >= 6) {
    const cs = Math.min(ctx.playerBias.sample_count / 20, 1.0)
    const raw = (ctx.playerBias.hit_rate - 0.50) * cs * 10
    biasAdj = Math.max(-5, Math.min(5, raw))
    if (direction === 'under') biasAdj = -biasAdj
  }

  // Opponent leak (mult=15, cap=±6 — see a815182)
  let leakAdj = 0
  if (ctx.opponentLeak && ctx.opponentLeak.sample_count >= 10) {
    const cs = Math.min(ctx.opponentLeak.sample_count / 40, 1.0)
    const raw = (ctx.opponentLeak.over_hit_rate - 0.50) * cs * 15
    leakAdj = Math.max(-6, Math.min(6, raw))
    if (direction === 'under') leakAdj = -leakAdj
  }

  // Line movement
  const lineMovementDelta = ctx.lineMovementDelta ?? null
  let lineMovAdj = 0
  if (lineMovementDelta != null && Math.abs(lineMovementDelta) >= 0.5) {
    const moved = Math.abs(lineMovementDelta)
    const mag = moved >= 2.0 ? 6 : moved >= 1.0 ? 4 : 2
    const confirming = direction === 'over' ? lineMovementDelta > 0 : lineMovementDelta < 0
    lineMovAdj = confirming ? mag : -mag
  }

  // Odds movement
  const oddsMovementDelta = ctx.oddsMovementDelta ?? null
  let oddsMovAdj = 0
  if (oddsMovementDelta != null && Math.abs(oddsMovementDelta) >= 0.03) {
    const abs = Math.abs(oddsMovementDelta)
    const mag = abs >= 0.10 ? 7 : abs >= 0.06 ? 5 : 3
    const confirming = direction === 'over' ? oddsMovementDelta > 0 : oddsMovementDelta < 0
    oddsMovAdj = confirming ? mag : -mag
  }

  // Minutes trend (L5 vs L20)
  let minutesTrendAdj = 0
  if (hasLogs) {
    const cutoff90 = dateCutoff(ct, 90)
    const mEligible = (cutoff90 ? gameLogs.filter((g) => g.game_date >= cutoff90) : gameLogs)
      .filter((g) => g.minutes >= 5)
    const ml5  = mEligible.slice(0, 5)
    const ml20 = mEligible.slice(0, 20)
    if (ml5.length >= 3 && ml20.length >= 8) {
      const avgM5  = ml5.reduce((s, g) => s + g.minutes, 0) / ml5.length
      const avgM20 = ml20.reduce((s, g) => s + g.minutes, 0) / ml20.length
      if (avgM20 > 0) {
        const trend = (avgM5 - avgM20) / avgM20
        if (Math.abs(trend) >= 0.10) {
          const mag = Math.abs(trend) >= 0.20 ? 3 : 2
          minutesTrendAdj = (trend > 0 ? mag : -mag) * (direction === 'over' ? 1 : -1)
        }
      }
    }
  }

  // Minutes uncertainty penalty (bench/fringe players)
  let minutesUncertaintyPenalty = 0
  if (hasLogs) {
    const mRecent = gameLogs.slice(0, 10).filter((g) => g.minutes >= 1)
    if (mRecent.length >= 4) {
      const avg = mRecent.reduce((s, g) => s + g.minutes, 0) / mRecent.length
      const variance = mRecent.reduce((s, g) => s + (g.minutes - avg) ** 2, 0) / mRecent.length
      const stdev = Math.sqrt(variance)
      if (avg < 20)      minutesUncertaintyPenalty = -8
      else if (avg < 24) minutesUncertaintyPenalty = -4
      if (stdev > 6)     minutesUncertaintyPenalty -= 3
    }
  }

  // Opponent B2B
  const opponentB2bAdj = ctx.opponentOnB2B ? (direction === 'over' ? 2 : -2) : 0

  // Consistency (L10 CV)
  let consistencyAdj = 0
  if (hasLogs) {
    const cv = consistencyCV(gameLogs, stat_type)
    if (cv != null) {
      const isVolatile = stat_type === 'blocks' || stat_type === 'steals'
      const lowCutoff  = isVolatile ? 0.55 : 0.30
      const highCutoff = isVolatile ? 0.85 : 0.50
      if (cv <= lowCutoff)                  consistencyAdj = 3
      else if (cv <= lowCutoff + 0.10)      consistencyAdj = 1
      else if (cv >= highCutoff)            consistencyAdj = -3
      else if (cv >= highCutoff - 0.10)     consistencyAdj = -1
    }
  }

  // Over-bias correction
  const obCfg = loadWeightConfig()
  const OVER_BIAS_DEFAULTS: Record<StatType, number> = {
    points: -3, rebounds: -4, assists: -4,
    steals: -10, blocks: -8, three_pointers: -7, pra: -4,
  }
  const OVER_BIAS_GATE = 0.50
  let overBiasAdj = 0
  if (direction === 'over') {
    const tr = ctx.overHitRates?.get(stat_type)
    if (tr == null || tr < OVER_BIAS_GATE) {
      overBiasAdj = obCfg?.over_bias?.[stat_type] ?? OVER_BIAS_DEFAULTS[stat_type] ?? -3
    }
  }

  // Under-bias correction
  const UNDER_BIAS_DEFAULTS: Record<StatType, number> = {
    blocks: +8, steals: +6, assists: +4, pra: +3,
    rebounds: +3, points: +2, three_pointers: +2,
  }
  const UNDER_BIAS_GATE = 0.50
  let underBiasAdj = 0
  if (direction === 'under') {
    const tr = ctx.underHitRates?.get(stat_type)
    if (tr == null || tr > UNDER_BIAS_GATE) {
      underBiasAdj = obCfg?.under_bias?.[stat_type] ?? UNDER_BIAS_DEFAULTS[stat_type] ?? 2
    }
  }

  // 3PM Monte Carlo sim
  let simAdj = 0
  if (stat_type === 'three_pointers' && ctx.simThreePm) {
    const edge = ctx.simThreePm.p_over - 0.50
    if (edge > 0.10)       simAdj = 6
    else if (edge > 0.05)  simAdj = 4
    else if (edge > 0.02)  simAdj = 2
    else if (edge < -0.10) simAdj = -6
    else if (edge < -0.05) simAdj = -4
    else if (edge < -0.02) simAdj = -2
    if (direction === 'under') simAdj = -simAdj
  }

  // Lineup confirmation (Phase 2 of lineups pipeline)
  let lineupAdj = 0
  if (ctx.confirmedStarter === false)     lineupAdj = -25
  else if (ctx.confirmedStarter === true) lineupAdj = 2

  // f11 was passed in but only used implicitly via consensus; void to silence lint
  void f11

  return {
    freshness,
    consensusAdj,
    starBonus,
    biasAdj,
    leakAdj,
    lineMovAdj,
    oddsMovAdj,
    minutesTrendAdj,
    minutesUncertaintyPenalty,
    overBiasAdj,
    underBiasAdj,
    opponentB2bAdj,
    simAdj,
    consistencyAdj,
    lineupAdj,
  }
}

/** Pre-computes all factor values for a prop. The optimizer calls this once per
 *  prop then replays just the weighted sum across thousands of weight vectors. */
export function computeFactors(
  prop: Prop,
  gameLogs: GameLog[],
  ctx: ScoringContext,
  hit: boolean,
): PrecomputedFactors {
  const { line, stat_type, direction } = prop
  const hasLogs = gameLogs.length >= 3

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
    playerBias       = null,
    opponentLeak     = null,
    dvpStats         = null,
    playerPosition   = null,
    opponentOnB2B    = null,
    homePace         = null,
    awayPace         = null,
  } = ctx

  const ct = prop.commence_time

  const hasHistoricalData = historicalLines.length >= 5
  const hr20 = hasLogs
    ? (hasHistoricalData
        ? (actualHitRate(gameLogs, historicalLines, stat_type, direction, 20, ct) ?? hitRate(gameLogs, stat_type, line, direction, 20, ct))
        : hitRate(gameLogs, stat_type, line, direction, 20, ct))
    : null
  const vsOpp    = hasLogs ? vsOpponentScore(gameLogs, stat_type, line, direction, opponentAbbr) : { score: 0.50, gamesFound: 0, hitsFound: 0, avgStat: 0 }
  const homeAway = hasLogs ? homeAwaySplit(gameLogs, stat_type, line, direction, isHome) : null

  const fLineValue = hasLogs ? lineValueScore(gameLogs, stat_type, line, direction, ct) : 0.50
  const f2  = matchupScore(defStats, stat_type, direction, dvpStats, playerPosition)
  const f3  = (hasLogs || seasonStats != null) ? cushionScore(gameLogs, stat_type, line, direction, seasonStats) : 0.50
  const f4  = vsOpp.score
  const f5  = homeAway ?? 0.50
  const f6  = hasLogs ? trendScore(gameLogs, stat_type, direction, ct) : 0.50
  const f7  = hr20    ?? 0.50
  const f10 = blowoutScore(spread)
  const f11 = newsInjuryScore(playerStatus, injuredTeammates)
  const f12 = restDaysScore(gameLogs, ct)
  const fPace = paceScore(gameTotal, stat_type, direction, homePace, awayPace)
  void opponentOnB2B  // used in scoreProps additive adj; not a multiplicative factor

  let playerTier: 'star' | 'starter' | 'rotation' = 'starter'
  if (hasLogs) {
    const recentLogs = gameLogs.slice(0, 10)
    const avgMins = recentLogs.reduce((s, g) => s + g.minutes, 0) / recentLogs.length
    if (avgMins >= 36) playerTier = 'star'
    else if (avgMins < 26) playerTier = 'rotation'
  }

  // All score-time additives — single source of truth shared with scoreProps.
  const adds = computeAdditives(
    prop,
    gameLogs,
    ctx,
    { fLineValue, f2, f3, f4, f5, f6, f7, f10, f11, f12, fPace },
    playerTier,
    hasLogs,
  )

  return {
    fLineValue, f2, f3, f4, f5, f6, f7, f10, f11, f12, fPace,
    freshness:                 adds.freshness,
    consensusAdj:              adds.consensusAdj,
    starBonus:                 adds.starBonus,
    biasAdj:                   adds.biasAdj,
    leakAdj:                   adds.leakAdj,
    minutesTrendAdj:           adds.minutesTrendAdj,
    lineMovAdj:                adds.lineMovAdj,
    oddsMovAdj:                adds.oddsMovAdj,
    minutesUncertaintyPenalty: adds.minutesUncertaintyPenalty,
    overBiasAdj:               adds.overBiasAdj,
    underBiasAdj:              adds.underBiasAdj,
    opponentB2bAdj:            adds.opponentB2bAdj,
    simAdj:                    adds.simAdj,
    consistencyAdj:            adds.consistencyAdj,
    lineupAdj:                 adds.lineupAdj,
    hasLogs, statType: stat_type, direction, hit,
  }
}

/** Apply a set of weights to pre-computed factors and return the confidence score + label. */
export function applyWeights(f: PrecomputedFactors, weights: Record<string, number>): { score: number; label: string } {
  let raw: number
  if (!f.hasLogs) {
    raw = f.f2 * 0.50 + f.f3 * 0.30 + f.f11 * 0.20
  } else {
    raw =
      f.fLineValue * weights.lineValue      +
      f.f2         * weights.matchupEdge    +
      f.f7         * weights.last20HitRate  +
      f.f6         * weights.trend          +
      f.f3         * weights.seasonCushion  +
      f.fPace      * weights.pace           +
      f.f11        * weights.newsInjury     +
      f.f12        * weights.restDays       +
      f.f10        * weights.blowout        +
      f.f5         * weights.homeAway       +
      f.f4         * weights.vsOpponent
  }
  const adjustedRaw = f.hasLogs ? (0.50 + (raw - 0.50) * f.freshness) : raw
  // MUST mirror the score formula in scoreProps exactly. The parity test in
  // lib/__tests__/confidence.test.ts asserts scoreProps and applyWeights ∘
  // computeFactors produce the same score for any given (prop, ctx).
  const score = Math.round(Math.min(95, Math.max(18,
    adjustedRaw * 100 +
    f.consensusAdj * f.freshness +
    f.starBonus +
    f.biasAdj +
    f.leakAdj +
    f.lineMovAdj +
    f.oddsMovAdj +
    f.minutesTrendAdj +
    f.minutesUncertaintyPenalty +
    f.overBiasAdj +
    f.underBiasAdj +
    f.opponentB2bAdj +
    f.simAdj +
    f.consistencyAdj +
    f.lineupAdj
  )))
  const label = getLabel(score, f.statType).label
  return { score, label }
}

// ── Main scoring function ─────────────────────────────────────────────────────
export function scoreProps(
  prop: Prop,
  gameLogs: GameLog[],
  _seasonAvg: Record<StatType, number> | null,  // kept for API compatibility
  contextOrDefStats: ScoringContext | TeamDefenseStats | null = null,
  weightsOverride?: WeightsOverride,
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
    playerBias       = null,
    opponentLeak     = null,
    dvpStats         = null,
    playerPosition   = null,
    opponentOnB2B    = null,
    homePace         = null,
    awayPace         = null,
  } = ctx

  // Compute all factors
  const ct = prop.commence_time  // shorthand for commenceTime threading

  // Use actual historical lines when available; fall back to retroactive line application
  const hasHistoricalData = historicalLines.length >= 5
  const hr20 = hasLogs
    ? (hasHistoricalData
        ? (actualHitRate(gameLogs, historicalLines, stat_type, direction, 20, ct) ?? hitRate(gameLogs, stat_type, line, direction, 20, ct))
        : hitRate(gameLogs, stat_type, line, direction, 20, ct))
    : null
  const vsOpp    = hasLogs ? vsOpponentScore(gameLogs, stat_type, line, direction, opponentAbbr) : { score: 0.50, gamesFound: 0, hitsFound: 0, avgStat: 0 }
  const homeAway = hasLogs ? homeAwaySplit(gameLogs, stat_type, line, direction, isHome) : null

  const fLineValue = hasLogs ? lineValueScore(gameLogs, stat_type, line, direction, ct) : 0.50
  const f2  = matchupScore(defStats, stat_type, direction, dvpStats, playerPosition)
  const hasCushion = hasLogs || seasonStats != null
  const f3  = hasCushion ? cushionScore(gameLogs, stat_type, line, direction, seasonStats) : 0.50
  const f4  = vsOpp.score
  const f5  = homeAway ?? 0.50
  const f6  = hasLogs ? trendScore(gameLogs, stat_type, direction, ct) : 0.50
  const f7  = hr20    ?? 0.50
  const f10 = blowoutScore(spread)
  const f11 = newsInjuryScore(playerStatus, injuredTeammates)
  const f12 = restDaysScore(gameLogs, ct)
  const fPace = paceScore(gameTotal, stat_type, direction, homePace, awayPace)

  // Detect player tier for reason text and star bonus
  let playerTier: 'star' | 'starter' | 'rotation' = 'starter'
  if (hasLogs) {
    const recentLogs = gameLogs.slice(0, 10)
    const avgMins = recentLogs.reduce((s, g) => s + g.minutes, 0) / recentLogs.length
    if (avgMins >= 36) playerTier = 'star'
    else if (avgMins < 26) playerTier = 'rotation'
  }

  const Wt = weightsOverride ? { ...getWeights(stat_type), ...weightsOverride } : getWeights(stat_type)

  let raw: number
  if (!hasLogs) {
    if (seasonStats != null) {
      raw = f2 * 0.50 + f3 * 0.30 + f11 * 0.20
    } else {
      raw = f2 * 0.70 + f11 * 0.30
    }
  } else {
    raw =
      fLineValue * Wt.lineValue      +
      f2         * Wt.matchupEdge    +
      f7         * Wt.last20HitRate  +
      f6         * Wt.trend          +
      f3         * Wt.seasonCushion  +
      fPace      * Wt.pace           +
      f11        * Wt.newsInjury     +
      f12        * Wt.restDays       +
      f10        * Wt.blowout        +
      f5         * Wt.homeAway       +
      f4         * Wt.vsOpponent
  }

  // All 14 score-time additives come from the shared computeAdditives helper.
  // See its definition above for the per-additive logic. Single source of truth
  // — applyWeights (used by the optimizer) reads the same values via
  // PrecomputedFactors so retrain and production always agree.
  const adds = computeAdditives(
    prop,
    gameLogs,
    ctx,
    { fLineValue, f2, f3, f4, f5, f6, f7, f10, f11, f12, fPace },
    playerTier,
    hasLogs,
  )
  const {
    freshness,
    consensusAdj,
    starBonus,
    biasAdj,
    leakAdj,
    lineMovAdj,
    oddsMovAdj,
    minutesTrendAdj,
    minutesUncertaintyPenalty,
    overBiasAdj,
    underBiasAdj,
    opponentB2bAdj,
    simAdj,
    consistencyAdj,
    lineupAdj,
  } = adds

  const adjustedRaw = hasLogs ? (0.50 + (raw - 0.50) * freshness) : raw

  // No-log cap: props without sufficient game log history (injury returns, new acquisitions)
  // are capped at 65 (top of PLAY) — insufficient data to justify LOCK confidence.
  // The score formula here MUST match applyWeights line-for-line; the parity test
  // in lib/__tests__/confidence.test.ts asserts equality.
  const scoreMax = hasLogs ? 95 : 65
  const score = Math.round(Math.min(scoreMax, Math.max(18,
    adjustedRaw * 100 +
    consensusAdj * freshness +
    starBonus +
    biasAdj +
    leakAdj +
    lineMovAdj +
    oddsMovAdj +
    minutesTrendAdj +
    minutesUncertaintyPenalty +
    overBiasAdj +
    underBiasAdj +
    opponentB2bAdj +
    simAdj +
    consistencyAdj +
    lineupAdj
  )))
  const { label, tier } = getLabel(score, stat_type)
  // Derive correct opponent display name from game-log-based opponentAbbr.
  // prop.opponent is unreliable (always set to away_team regardless of which side the player is on).
  const opponentDisplayName = opponentAbbr
    ? (ABBR_TO_TEAM[opponentAbbr] ?? null)
    : (prop.opponent && prop.opponent !== 'TBD' ? prop.opponent : null)
  const reason = buildReason(
    prop, gameLogs, fLineValue, hr20, f3, f6, f2, hasLogs, defStats, vsOpp, isHome,
    spread, playerStatus, injuredTeammates, seasonStats, gameTotal, freshness, playerTier,
    ctx.lineMovementDelta ?? null,
    ctx.oddsMovementDelta ?? null,
    opponentDisplayName,
    ctx,
  )

  // confidence_score is the RAW score (used for tier mapping, sorting, dedup).
  // For honest user-facing probabilities, render via applyCalibration() at
  // display time — see lib/calibration.ts and components/ConfidenceBadge.tsx.
  return { ...prop, confidence_score: score, confidence_label: label, risk_tier: tier, confidence_reason: reason }
}

// ── Label thresholds ──────────────────────────────────────────────────────────
// Tiers (NBA betting-themed, 4 levels) — current as of v11.0:
//   LOCK  (≥74): elite picks — strongest log-based signal (base threshold v6→v7→v11: 68→72→74)
//   PLAY  (≥68): high confidence (base v11: 66→68)
//   LEAN  (50–67): moderate signal
//   FADE  (<50):  model leans against
//
// Stat-specific LOCK thresholds — last touched in v11 from diagnostic-pipeline LOCK hit rates.
// History: v7 PIT calibration raised base LOCK 68→72 (scores 65-69 hit ~49% = coin flip).
// v11 raised assists/blocks/3PM further after diagnostic showed sub-55% LOCK rates at v7 levels.
// PLAY thresholds: LOCK − 4 to − 6 (tighter band keeps PLAY meaningful).
const LOCK_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        78,  // v11: raised from 74 — 50.0% on 14 LOCKs was unacceptable
  pra:            78,  // v10: 72.7% — keep at 78
  steals:         78,  // v10: 92.9% — keep at 78
  blocks:         78,  // v11: raised from 74 — 52.6% on 19 LOCKs was too low
  three_pointers: 76,  // v11: raised from 72 — 48.9% on 45 LOCKs was worst performer
  rebounds:       74,  // v10: 66.7% on 24 LOCKs — acceptable, keep at 74
}
const PLAY_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        72,  // v11: raised from 68 — LOCK-6
  pra:            76,  // v10: keep at 76
  steals:         72,  // v10: keep at 72
  blocks:         74,  // v11: raised from 72 — LOCK-4 (tighter band for volatile stat)
  three_pointers: 70,  // v11: raised from 66 — LOCK-6
  rebounds:       72,  // v10: keep at 72
  points:         70,  // v10: keep at 70
}

function getLabel(score: number, statType?: StatType): { label: ConfidenceLabel; tier: RiskTier } {
  const config = loadWeightConfig()
  const lockThreshold = (statType && (config?.lock_thresholds[statType] ?? LOCK_THRESHOLD_BY_STAT[statType])) ?? (config?.base_lock_threshold ?? 74)
  const playThreshold = (statType && (config?.play_thresholds[statType] ?? PLAY_THRESHOLD_BY_STAT[statType])) ?? (config?.base_play_threshold ?? 68)
  if (score >= lockThreshold) return { label: 'LOCK', tier: 'PRIME'    }
  if (score >= playThreshold) return { label: 'PLAY', tier: 'LOW_RISK' }
  if (score >= 50)            return { label: 'LEAN', tier: 'MED_RISK' }
  return                             { label: 'FADE', tier: 'HIGH_RISK' }
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
  freshness?: number,
  playerTier?: 'star' | 'starter' | 'rotation',
  lineMovementDelta?: number | null,
  oddsMovementDelta?: number | null,
  opponentName?: string | null,
  ctx?: ScoringContext | null,
): string {
  const { stat_type, line, direction, player_name, opponent: rawOpponent } = prop
  // Use game-log-derived opponent name when available (more reliable than prop.opponent,
  // which is always set to away_team regardless of which side the player is on).
  const opponent = opponentName ?? (rawOpponent && rawOpponent !== 'TBD' ? rawOpponent : null)
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

  // 0a. Data staleness warning — show before anything else when data is significantly old
  if (freshness != null && freshness <= 0.55 && logs.length > 0) {
    const lastGame = logs[0].game_date
    const gapDays  = Math.round((new Date(prop.commence_time ?? Date.now()).getTime() - new Date(lastGame).getTime()) / 86400000)
    sentences.push(
      `⚠️ Data may be stale — last game was ${gapDays} days ago. ` +
      `Historical stats are discounted; confidence reflects higher uncertainty on return.`
    )
  }

  // 0b. News / injury — lead with this if it's impactful
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

  // 1b. Last 20 hit rate — count actual hits from raw logs (not back-calculated from weighted rate)
  if (hr20 !== null) {
    const cutoff90  = dateCutoff(prop.commence_time, 90)
    const activeLogs = logs.filter((g) => g.minutes >= 5)
    const window20  = (cutoff90 ? activeLogs.filter((g) => g.game_date >= cutoff90) : activeLogs).slice(0, 20)
    const hits20    = window20.filter((g) =>
      dir === 'over' ? getStatValue(g, stat_type) > line : getStatValue(g, stat_type) < line
    ).length
    const total20   = window20.length
    if (total20 >= 3) {
      sentences.push(
        `${player_name} has gone ${dir} ${line} ${stat} in ${hits20} of their last ${total20} games.`
      )
    }
  }

  // 2. Head-to-head vs this opponent
  if (vsOpp.gamesFound >= 2) {
    const oppName = opponent ?? 'this opponent'
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

  // 5. Minutes per game + player tier note
  const recentLogs = logs.slice(0, 10).filter((g) => g.minutes > 0)
  if (recentLogs.length >= 3) {
    const avgMin = recentLogs.reduce((a, g) => a + g.minutes, 0) / recentLogs.length
    sentences.push(`Playing ${avgMin.toFixed(0)} minutes per game over the last ${recentLogs.length} games.`)
    if (playerTier === 'star') {
      sentences.push(`Star-player usage — high-volume role strengthens confidence in log-based signals.`)
    } else if (playerTier === 'rotation') {
      sentences.push(`Rotation player — variable role means situational context (matchup/injury) matters more than historical averages.`)
    }
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
      const oppName = opponent ?? "tonight's opponent"
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

  // 9. Consistency + minutes stability notes (use precomputed modifiers when available)
  // Stat consistency note (informational — does not affect score)
  {
    const vals = logs.slice(0, 10).map((g) => getStatValue(g, stat_type)).filter((v) => v >= 0)
    if (vals.length >= 5) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      if (mean >= 1.0) {
        const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
        const cv = Math.sqrt(variance) / mean
        if (cv < 0.25) {
          sentences.push(`Rock-solid consistency for this stat — very low game-to-game variance.`)
        } else if (cv >= 0.70) {
          sentences.push(`High-variance stat — ${player_name}'s ${stat} swings significantly game to game.`)
        }
      }
    }
  }
  // Minutes stability note (informational — does not affect score)
  {
    const recentMins = logs.slice(0, 10).map((g) => g.minutes).filter((m) => m > 0)
    if (recentMins.length >= 5) {
      const mn     = recentMins.reduce((a, b) => a + b, 0) / recentMins.length
      const stdev  = Math.sqrt(recentMins.reduce((s, m) => s + (m - mn) ** 2, 0) / recentMins.length)
      if (stdev >= 10) {
        sentences.push(`Minutes vary significantly (σ≈${stdev.toFixed(0)} min/game) — playing time uncertainty is high.`)
      }
    }
  }

  // 10. Sharp money signals (line movement + odds movement)
  if (lineMovementDelta != null && Math.abs(lineMovementDelta) >= 0.5) {
    const confirming = dir === 'over' ? lineMovementDelta > 0 : lineMovementDelta < 0
    const moved = Math.abs(lineMovementDelta).toFixed(1)
    const dirStr = lineMovementDelta > 0 ? 'up' : 'down'
    sentences.push(
      confirming
        ? `Line moved ${dirStr} ${moved} pts since opening — sharp money confirming the ${dir.toUpperCase()}.`
        : `Line moved ${dirStr} ${moved} pts since opening — market action going against the ${dir.toUpperCase()}.`
    )
  }
  if (oddsMovementDelta != null && Math.abs(oddsMovementDelta) >= 0.03) {
    const confirming = dir === 'over' ? oddsMovementDelta > 0 : oddsMovementDelta < 0
    const pctShift   = (Math.abs(oddsMovementDelta) * 100).toFixed(0)
    sentences.push(
      confirming
        ? `Odds juice shifted +${pctShift}pp toward the ${dir.toUpperCase()} since morning — sharp syndicate action detected.`
        : `Odds juice shifted ${pctShift}pp away from the ${dir.toUpperCase()} since morning — books taking ${dir === 'over' ? 'under' : 'over'} action.`
    )
  }

  // 11. 3PM simulation note
  if (stat_type === 'three_pointers' && ctx?.simThreePm) {
    const pOverPct = (ctx.simThreePm.p_over * 100).toFixed(0)
    const meanStr = ctx.simThreePm.sim_mean.toFixed(1)
    if (ctx.simThreePm.p_over > 0.55) {
      sentences.push(`Zone sim model projects ${meanStr} 3PM avg (${pOverPct}% over) — zone-adjusted defense favors the OVER.`)
    } else if (ctx.simThreePm.p_over < 0.45) {
      sentences.push(`Zone sim model projects ${meanStr} 3PM avg (only ${pOverPct}% over) — zone-adjusted defense limits upside.`)
    } else {
      sentences.push(`Zone sim model projects ${meanStr} 3PM avg (${pOverPct}% over) — neutral zone-defense signal.`)
    }
  }

  return sentences.join(' ') || 'Limited data available for this pick.'
}
