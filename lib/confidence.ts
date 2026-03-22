// Prizm Confidence Engine v6.1
//
// Weights from optimizer run 4 (50,000 Dirichlet samples + hill-climbing, min 80 LOCK props):
//   Training set: 33,644 OVER props (real sportsbook lines only).
//   Game log history: 2024-25 + 2025-26 seasons (37,070 rows across 347 players).
//   Consensus of top 10 results — balances quality AND volume.
//
//   Key shifts from v5.9 (added 24-25 season game logs + threshold optimization):
//   - homeAway:       0.08 → 0.18  (+10pp — full season context = much stronger home/away split)
//   - matchupEdge:    0.04 → 0.14  (+10pp — opponent defense more impactful with more context)
//   - blowout:        0.09 → 0.11  (+2pp)
//   - last20HitRate:  0.27 → 0.18  (-9pp — less dominant; more factors now carry signal)
//   - vsOpponent:     0.11 → 0.04  (-7pp — head-to-head weaker predictor than expected)
//   - pace:           0.08 → 0.05  (-3pp)
//   - lineValue:      0.04 → 0.02  (-2pp)
//   Threshold: base 70 → 68 (stat-specific offsets unchanged: assists/pra +6, 3PM +4)
//   Projected: ~80.8% LOCK hit rate at ~85 LOCK props (vs v5.9: 75.5% at 98 props)
//
// Factors & weights (sum = 1.00):
//   1.  lineValue      ( 2%) — z-score of tonight's line vs player's L10 average + stdev
//                              Only uses games within the last 60 days (date-windowed).
//   2.  matchupEdge    (14%) — opponent's defensive rank for this stat
//   3.  last20HitRate  (18%) — exponentially-weighted hit rate (recent games count more)
//                              Filtered to games within last 90 days.
//   4.  trend          (12%) — L5 vs L20 momentum (90-day window)
//   5.  seasonCushion  ( 2%) — season average cushion above/below tonight's line
//   6.  pace           ( 5%) — game O/U total as pace proxy — high-scoring games = more stats
//   7.  newsInjury     ( 9%) — injury report: teammate out = usage boost, player Q = risk
//   8.  restDays       ( 5%) — back-to-back fatigue; well-rested boost
//   9.  blowout        (11%) — large spread = starters may sit 4th quarter
//  10.  homeAway       (18%) — home vs away performance split (strongest signal with full history)
//  11.  vsOpponent     ( 4%) — hit rate vs this specific team (Bayesian-blended)
//
// Additive adjustments (not in weight sum):
//   - minutesTrendAdj: ±2–3 pts if L5 minutes significantly above/below L20 baseline
//   - lineMovAdj:      ±2–6 pts for sharp money signal (line value movement vs pick direction)
//   - oddsMovAdj:     ±3–7 pts for odds movement (P(over) shift ≥3pp since morning snapshot)
//   - biasAdj:         ±0–5 pts from player-specific historical over/under bias
//   - leakAdj:         ±0–4 pts from opponent team defensive leak for this stat
//   - starBonus:       +3 pts for ≥36 min avg stars with generous line + hot hit rate
//   - consensusAdj:    +3/0/−4/−10 based on how many primary factors agree
//
// Data freshness: if a player's last game was >7 days ago, all log-based factor scores
// are compressed toward 0.50 proportionally. A 2-month absence = ~35% of signal retained.
// This prevents injury-return picks from scoring HIGH based on pre-injury form.
//
// Stat-specific weight sets: steals/blocks use W_VOLATILE (matchupEdge+vsOpponent↑, trend+hitRate↓).
//   three_pointers use W_THREE_POINTERS (trend+pace↑, homeAway↓). All other stats use W.
// LOCK threshold: 68 (stat-specific: assists/pra ≥74, steals/blocks/3PM ≥72).
// Star bonus: +3 pts for star players (≥36 min avg) with lineValue ≥0.58 + hitRate ≥0.55.

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
}

export interface ScoredProp extends Prop {
  confidence_score:  number
  confidence_label:  ConfidenceLabel
  risk_tier:         RiskTier
  confidence_reason: string
}

// ── Factor weights ────────────────────────────────────────────────────────────
// Universal weights (points, rebounds, assists, pra)
const W = {
  lineValue:      0.02,
  matchupEdge:    0.14,
  last20HitRate:  0.18,
  trend:          0.12,
  seasonCushion:  0.02,
  pace:           0.05,
  newsInjury:     0.09,
  restDays:       0.05,
  blowout:        0.11,
  homeAway:       0.18,
  vsOpponent:     0.04,
}  // sum = 1.00

// Steals + Blocks: ultra-volatile, integer-valued, opponent-style-driven.
//   matchupEdge ↑↑ — defensive schemes drive steal/block opportunities far more than form
//   vsOpponent ↑↑  — head-to-head history is meaningful (e.g. bigs that always get blocks vs drive-heavy teams)
//   last20HitRate ↓ — high game-to-game variance makes rolling hit rate noisy
//   trend ↓         — L5 vs L20 is unreliable for 1-2 unit stats
//   homeAway ↓      — less home/away split for these stats
//   pace ↓          — pace matters less; steals/blocks don't scale strongly with possessions
const W_VOLATILE: typeof W = {
  lineValue:      0.06,
  matchupEdge:    0.20,
  last20HitRate:  0.10,
  trend:          0.08,
  seasonCushion:  0.04,
  pace:           0.03,
  newsInjury:     0.10,
  restDays:       0.05,
  blowout:        0.08,
  homeAway:       0.10,
  vsOpponent:     0.16,
}  // sum = 1.00

// Three-pointers: streaky but higher volume than steals/blocks.
//   trend ↑         — shooter streaks are the most predictive signal for 3PM
//   pace ↑          — more possessions = more 3PT attempts
//   matchupEdge ↑   — some defenses give up far more 3s than others
//   last20HitRate ↓ — discrete (0/1/2/3...) makes rolling rate noisier than for pts
//   homeAway ↓      — slightly less meaningful than for standard stats
const W_THREE_POINTERS: typeof W = {
  lineValue:      0.04,
  matchupEdge:    0.16,
  last20HitRate:  0.14,
  trend:          0.14,
  seasonCushion:  0.04,
  pace:           0.10,
  newsInjury:     0.08,
  restDays:       0.05,
  blowout:        0.09,
  homeAway:       0.12,
  vsOpponent:     0.04,
}  // sum = 1.00

/** Pick the right weight set for the stat type */
function getWeights(statType: StatType): typeof W {
  if (statType === 'steals' || statType === 'blocks') return W_VOLATILE
  if (statType === 'three_pointers') return W_THREE_POINTERS
  return W
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
//   ≤7 days (playing regularly): 1.00 — no decay
//   8–14 days (missed ~1 week):  0.88 — mild decay
//   15–21 days (missed 2 weeks): 0.72 — moderate decay
//   22–45 days (missed 3+ wks):  0.55 — significant decay
//   46–90 days (out 6+ weeks):   0.35 — major decay
//   >90 days  (out 3+ months):   0.15 — near-neutral (e.g., Tatum returning from year out)
function dataFreshness(logs: GameLog[], commenceTime: string | undefined): number {
  if (!logs.length || !commenceTime) return 0.70
  const lastGame = new Date(logs[0].game_date)
  const tonight  = new Date(commenceTime)
  const gapDays  = (tonight.getTime() - lastGame.getTime()) / 86400000

  if (gapDays > 90) return 0.15
  if (gapDays > 45) return 0.35
  if (gapDays > 21) return 0.55
  if (gapDays > 14) return 0.72
  if (gapDays > 7)  return 0.88
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

export type WeightsOverride = Partial<typeof W>

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
  hasLogs:     boolean
  statType:    StatType
  direction:   'over' | 'under'
  hit:         boolean  // did OVER actually hit?
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
  const f2  = matchupScore(defStats, stat_type, direction)
  const f3  = (hasLogs || seasonStats != null) ? cushionScore(gameLogs, stat_type, line, direction, seasonStats) : 0.50
  const f4  = vsOpp.score
  const f5  = homeAway ?? 0.50
  const f6  = hasLogs ? trendScore(gameLogs, stat_type, direction, ct) : 0.50
  const f7  = hr20    ?? 0.50
  const f10 = blowoutScore(spread)
  const f11 = newsInjuryScore(playerStatus, injuredTeammates)
  const f12 = restDaysScore(gameLogs, ct)
  const fPace = paceScore(gameTotal, stat_type, direction)

  let playerTier: 'star' | 'starter' | 'rotation' = 'starter'
  if (hasLogs) {
    const recentLogs = gameLogs.slice(0, 10)
    const avgMins = recentLogs.reduce((s, g) => s + g.minutes, 0) / recentLogs.length
    if (avgMins >= 36) playerTier = 'star'
    else if (avgMins < 26) playerTier = 'rotation'
  }

  const primaryFactors = [fLineValue, f2, f7, f6, f3]
  const agreeCount = primaryFactors.filter((f) => f >= 0.55).length
  const consensusAdj = agreeCount >= 4 ? 3 : agreeCount >= 3 ? 0 : agreeCount >= 2 ? -4 : -10
  const freshness = hasLogs ? dataFreshness(gameLogs, ct) : 1.00

  let starBonus = 0
  if (hasLogs && playerTier === 'star' && fLineValue >= 0.58 && f7 >= 0.55) starBonus = 3

  let biasAdj = 0
  if (playerBias && playerBias.sample_count >= 6) {
    const confidenceScale = Math.min(playerBias.sample_count / 20, 1.0)
    const rawAdj = (playerBias.hit_rate - 0.50) * confidenceScale * 10
    biasAdj = Math.max(-5, Math.min(5, rawAdj))
    if (direction === 'under') biasAdj = -biasAdj
  }

  // Opponent leak: team-specific defensive tendency for this stat.
  // Scale: (hit_rate - 0.50) × confidenceScale × 8, capped at ±4 pts.
  // Weaker signal than player bias (team tendencies shift more than player habits).
  let leakAdj = 0
  if (opponentLeak && opponentLeak.sample_count >= 10) {
    const confidenceScale = Math.min(opponentLeak.sample_count / 40, 1.0)
    const rawAdj = (opponentLeak.over_hit_rate - 0.50) * confidenceScale * 8
    leakAdj = Math.max(-4, Math.min(4, rawAdj))
    if (direction === 'under') leakAdj = -leakAdj
  }

  // Minutes trend: L5 vs L20 minutes divergence → counting stat volume signal
  let minutesTrendAdj = 0
  if (hasLogs) {
    const cutoff90m = dateCutoff(ct, 90)
    const mEligible = (cutoff90m ? gameLogs.filter((g) => g.game_date >= cutoff90m) : gameLogs)
      .filter((g) => g.minutes >= 5)
    const ml5  = mEligible.slice(0, 5)
    const ml20 = mEligible.slice(0, 20)
    if (ml5.length >= 3 && ml20.length >= 8) {
      const avgM5  = ml5.reduce((s, g) => s + g.minutes, 0) / ml5.length
      const avgM20 = ml20.reduce((s, g) => s + g.minutes, 0) / ml20.length
      if (avgM20 > 0) {
        const minsTrend = (avgM5 - avgM20) / avgM20
        if (Math.abs(minsTrend) >= 0.10) {
          const mag = Math.abs(minsTrend) >= 0.20 ? 3 : 2
          minutesTrendAdj = (minsTrend > 0 ? mag : -mag) * (direction === 'over' ? 1 : -1)
        }
      }
    }
  }

  return {
    fLineValue, f2, f3, f4, f5, f6, f7, f10, f11, f12, fPace,
    freshness, consensusAdj, starBonus, biasAdj, leakAdj, minutesTrendAdj,
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
  const score = Math.round(Math.min(95, Math.max(18,
    adjustedRaw * 100 + f.consensusAdj * f.freshness + f.starBonus + f.biasAdj + f.leakAdj + f.minutesTrendAdj
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
  const f2  = matchupScore(defStats, stat_type, direction)
  const hasCushion = hasLogs || seasonStats != null
  const f3  = hasCushion ? cushionScore(gameLogs, stat_type, line, direction, seasonStats) : 0.50
  const f4  = vsOpp.score
  const f5  = homeAway ?? 0.50
  const f6  = hasLogs ? trendScore(gameLogs, stat_type, direction, ct) : 0.50
  const f7  = hr20    ?? 0.50
  const f10 = blowoutScore(spread)
  const f11 = newsInjuryScore(playerStatus, injuredTeammates)
  const f12 = restDaysScore(gameLogs, ct)
  const fPace = paceScore(gameTotal, stat_type, direction)

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

  // Consensus bonus/penalty: count how many of the 5 primary factors agree (≥0.55)
  const primaryFactors = [fLineValue, f2, f7, f6, f3]
  const agreeCount = primaryFactors.filter((f) => f >= 0.55).length
  const consensusAdj = agreeCount >= 4 ? 3 : agreeCount >= 3 ? 0 : agreeCount >= 2 ? -4 : -10

  // Freshness: multiplicative (most impactful — compresses all log-based signal
  // when the player has been out for a while). Validated by model design.
  const freshness = hasLogs ? dataFreshness(gameLogs, ct) : 1.00
  const adjustedRaw = hasLogs ? (0.50 + (raw - 0.50) * freshness) : raw

  // Star bonus: additive boost for high-usage players (≥36 min avg) when both
  // lineValue AND hit rate are bullish. Stars are matchup-proof so log-based
  // signals are more reliable for them. Only fires for OVER props (log signals
  // are directional — high-usage stars skew volume upward).
  // Additive-only: never penalizes; cannot push a pick below its current score.
  // Requires both lineValue ≥ 0.58 (generous line) AND hit rate ≥ 0.55 (hot).
  let starBonus = 0
  if (hasLogs && playerTier === 'star' && fLineValue >= 0.58 && f7 >= 0.55) {
    starBonus = 3
  }

  // Player line bias adjustment: if the book has historically under/overpriced
  // this player for this stat, apply a small calibration bump.
  // Formula: (hit_rate - 0.50) × confidence_scale × 10, capped at ±5 pts.
  // confidence_scale = min(sample_count / 20, 1.0) — grows toward full weight at 20+ games.
  // Direction: OVER props get positive adj for high hit_rate, negative for low.
  let biasAdj = 0
  if (playerBias && playerBias.sample_count >= 6) {
    const confidenceScale = Math.min(playerBias.sample_count / 20, 1.0)
    const rawAdj = (playerBias.hit_rate - 0.50) * confidenceScale * 10
    biasAdj = Math.max(-5, Math.min(5, rawAdj))
    if (direction === 'under') biasAdj = -biasAdj
  }

  // Opponent leak adjustment: some teams give up specific stats at elevated rates
  // regardless of their overall defensive rank. Weaker signal than player bias
  // (team tendencies shift more), so capped at ±4 pts with higher sample floor.
  // Formula: (over_hit_rate - 0.50) × confidence_scale × 8, capped at ±4 pts.
  let leakAdj = 0
  if (opponentLeak && opponentLeak.sample_count >= 10) {
    const confidenceScale = Math.min(opponentLeak.sample_count / 40, 1.0)
    const rawAdj = (opponentLeak.over_hit_rate - 0.50) * confidenceScale * 8
    leakAdj = Math.max(-4, Math.min(4, rawAdj))
    if (direction === 'under') leakAdj = -leakAdj
  }

  // Sharp money / line movement adjustment:
  // A line moving in the same direction as the pick (e.g. OVER and line goes up)
  // signals sharp/syndicate money confirming the direction → +2 to +6 pts.
  // A line moving against the pick direction → -2 to -6 pts.
  // Threshold: |delta| must be ≥ 0.5 to avoid noise.
  const lineMovementDelta = ctx.lineMovementDelta ?? null
  let lineMovAdj = 0
  if (lineMovementDelta != null && Math.abs(lineMovementDelta) >= 0.5) {
    const moved = Math.abs(lineMovementDelta)
    const magnitude = moved >= 2.0 ? 6 : moved >= 1.0 ? 4 : 2
    // For OVER: line up = sharp money on OVER = confirming; line down = COUNTER
    // For UNDER: line down = sharp money on UNDER = confirming; line up = COUNTER
    const confirming = direction === 'over' ? lineMovementDelta > 0 : lineMovementDelta < 0
    lineMovAdj = confirming ? magnitude : -magnitude
  }

  // Odds movement adjustment (sharp money signal):
  // Books move juice before moving the line — when implied probability shifts ≥3pp
  // without a corresponding line move, it's a stronger signal of syndicate action.
  // Uses P(over) computed from American odds: |odds|/(|odds|+100) for negative, 100/(odds+100) for positive.
  // oddsMovementDelta = P_now − P_open (positive = more OVER action since morning snapshot)
  // Confirming direction → +3/5/7 pts; counter → −3/5/7 pts.
  // Only triggers when |delta| ≥ 0.03 (3pp implied prob shift) to filter noise.
  const oddsMovementDelta = ctx.oddsMovementDelta ?? null
  let oddsMovAdj = 0
  if (oddsMovementDelta != null && Math.abs(oddsMovementDelta) >= 0.03) {
    const absDelta  = Math.abs(oddsMovementDelta)
    const magnitude = absDelta >= 0.10 ? 7 : absDelta >= 0.06 ? 5 : 3
    const confirming = direction === 'over' ? oddsMovementDelta > 0 : oddsMovementDelta < 0
    oddsMovAdj = confirming ? magnitude : -magnitude
  }

  // Minutes trend adjustment: if a player's recent minutes (L5) are significantly
  // higher than their rolling baseline (L20), they're getting more time = more counting
  // stat volume. ±2 pts at ≥10% change, ±3 pts at ≥20% change. Applies to all stat types.
  let minutesTrendAdj = 0
  if (hasLogs) {
    const cutoff90m = dateCutoff(ct, 90)
    const mEligible = (cutoff90m ? gameLogs.filter((g) => g.game_date >= cutoff90m) : gameLogs)
      .filter((g) => g.minutes >= 5)
    const ml5  = mEligible.slice(0, 5)
    const ml20 = mEligible.slice(0, 20)
    if (ml5.length >= 3 && ml20.length >= 8) {
      const avgM5  = ml5.reduce((s, g) => s + g.minutes, 0) / ml5.length
      const avgM20 = ml20.reduce((s, g) => s + g.minutes, 0) / ml20.length
      if (avgM20 > 0) {
        const minsTrend = (avgM5 - avgM20) / avgM20
        if (Math.abs(minsTrend) >= 0.10) {
          const mag = Math.abs(minsTrend) >= 0.20 ? 3 : 2
          // Trending up → positive for OVER (more minutes = more production)
          // Trending down → negative for OVER, positive for UNDER
          minutesTrendAdj = (minsTrend > 0 ? mag : -mag) * (direction === 'over' ? 1 : -1)
        }
      }
    }
  }

  const score = Math.round(Math.min(95, Math.max(18,
    adjustedRaw * 100 + consensusAdj * freshness + starBonus + biasAdj + leakAdj + lineMovAdj + oddsMovAdj + minutesTrendAdj
  )))
  const { label, tier } = getLabel(score, stat_type)
  const reason = buildReason(
    prop, gameLogs, fLineValue, hr20, f3, f6, f2, hasLogs, defStats, vsOpp, isHome,
    spread, playerStatus, injuredTeammates, seasonStats, gameTotal, freshness, playerTier,
    ctx.lineMovementDelta ?? null,
    ctx.oddsMovementDelta ?? null,
  )

  return { ...prop, confidence_score: score, confidence_label: label, risk_tier: tier, confidence_reason: reason }
}

// ── Label thresholds ──────────────────────────────────────────────────────────
// v6.0 tiers (NBA betting-themed, 4 levels):
//   LOCK  (≥68): elite picks — strongest log-based signal
//   PLAY  (60–67): high confidence
//   LEAN  (50–59): moderate signal
//   FADE  (<50):  model leans against
//
// Stat-specific LOCK thresholds (base + offset, backtest-derived):
//   assists / pra: base + 6 = 74 (volatile combined stats, require higher bar)
//   steals / blocks / three_pointers: base + 4 = 72 (hard-to-predict volatile stats)
//   all others: 68 (standard)
//
// PLAY thresholds: LOCK - 8.
const LOCK_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        74,  // volatile: require higher bar (base 68 + 6)
  pra:            74,
  steals:         72,  // ultra-volatile: higher bar (base 68 + 4)
  blocks:         72,
  three_pointers: 72,  // discrete/streaky stat (base 68 + 4)
}
const PLAY_THRESHOLD_BY_STAT: Partial<Record<StatType, number>> = {
  assists:        70,
  pra:            66,
  steals:         64,
  blocks:         64,
  three_pointers: 64,
}

function getLabel(score: number, statType?: StatType): { label: ConfidenceLabel; tier: RiskTier } {
  const lockThreshold = (statType && LOCK_THRESHOLD_BY_STAT[statType]) ?? 68
  const playThreshold = (statType && PLAY_THRESHOLD_BY_STAT[statType]) ?? 60
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
          sentences.push(`⚠️ High-variance stat — ${player_name}'s ${stat} swings significantly game to game.`)
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
        sentences.push(`⚠️ Minutes vary significantly (σ≈${stdev.toFixed(0)} min/game) — playing time uncertainty is high.`)
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
        ? `📈 Line moved ${dirStr} ${moved} pts since opening — sharp money confirming the ${dir.toUpperCase()}.`
        : `📉 Line moved ${dirStr} ${moved} pts since opening — market action going against the ${dir.toUpperCase()}.`
    )
  }
  if (oddsMovementDelta != null && Math.abs(oddsMovementDelta) >= 0.03) {
    const confirming = dir === 'over' ? oddsMovementDelta > 0 : oddsMovementDelta < 0
    const pctShift   = (Math.abs(oddsMovementDelta) * 100).toFixed(0)
    sentences.push(
      confirming
        ? `💰 Odds juice shifted +${pctShift}pp toward the ${dir.toUpperCase()} since morning — sharp syndicate action detected.`
        : `⚠️ Odds juice shifted ${pctShift}pp away from the ${dir.toUpperCase()} since morning — books taking ${dir === 'over' ? 'under' : 'over'} action.`
    )
  }

  return sentences.join(' ') || 'Limited data available for this pick.'
}
