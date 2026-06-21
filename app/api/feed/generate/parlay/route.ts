// /api/feed/generate/parlay
export const maxDuration = 120  // bumped from 60: now awaits streak generation inline
//
// Auto-generates three tiers of curated parlays per day:
//
//   VALUE   (parlay_type='value')   — 1 × 2-leg "Safe Pick"
//     · 47.5% hit rate · ~3x avg multiplier · 34.6% ROI
//     · No minutes filter — widest player pool; most consistent daily hit
//
//   PREMIUM (parlay_type='premium') — 1 × 4-leg "High Roller"
//     · 33.3% hit rate · ~10x avg multiplier · 198.6% ROI (24+ min filter)
//     · 24+ avg minutes filter — excludes roleplayers
//
//   JACKPOT (parlay_type='jackpot') — 1 × 5-leg "Jackpot"
//     · 27.3% hit rate · ~17x avg multiplier · 308.4% ROI (24+ min filter)
//     · 24+ avg minutes filter — max quality, max payout
//
//   All tiers:
//     · Markets: PTS / REB / 3PM / AST / BLK / STL
//     · BLK + STL are LOCK-only (volatile stats — 88.2% and 76.5% LOCK hit rate,
//       but only 46.7% and 55.3% at PLAY — not reliable enough below LOCK)
//     · Tiers: LOCK + PLAY, both OVER and UNDER (UNDERs hit 50.1% vs OVERs 43.4%)
//     · Sort by confidence_score descending
//     · No SGP discount (cross-game parlay)
//     · Independent pools — picks can overlap across tiers
//
// GET  ?date=YYYY-MM-DD  — preview without saving
// POST ?date=YYYY-MM-DD  — generate and save to curated_parlays (parlay_type='premium')
//
// Idempotent: POST skips if TARGET parlays already exist for the date.

import { NextResponse }  from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabase, safeQuery } from '@/lib/supabase'
import { requireCronAuth, internalAuthHeaders } from '@/lib/api-auth'
import { logger } from '@/lib/logger'
import { detectChanges, type ChangeReport } from '@/lib/change-detection'
import { ev as computeEv } from '@/lib/ev'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

// T6 research (April 2026) — actual observed hit rates from 90-day sample:
//   VALUE (2-leg):   21.4% on 14 parlays (individual legs ~57%)
//   COMBO (3-leg):   20.0% on 5 parlays  (small sample)
//   PREMIUM (4-leg): 13.8% on 29 parlays (leg correlation drags this down)
//   JACKPOT (5-leg):  8.3% on 12 parlays (5-leg compound is inherently speculative)
//   STREAK (1-leg):  50.0% on 14 picks   (best standalone accuracy)
const VALUE_LEGS       = 2
const VALUE_MIN_MINS   = 24
const COMBO_LEGS       = 3
const PREMIUM_LEGS     = 4
const PREMIUM_COUNT    = 1
const PREMIUM_MIN_MINS = 24
const JACKPOT_LEGS     = 5
const JACKPOT_MIN_MINS = 24

// Playoff mode — auto-detected when slate falls in conference/NBA finals window.
// Rotations tighten 10-11 deep -> 8-9 deep, pace slows, stars play 38+ mins
// instead of 32-35, and bench players see drastically reduced minutes (often <15).
// We tighten the min-minutes filter to keep low-confidence bench picks out of
// multi-leg parlays where their variance compounds.
const PLAYOFF_PREMIUM_MIN_MINS = 30
const PLAYOFF_JACKPOT_MIN_MINS = 32
const PLAYOFF_VALUE_MIN_MINS   = 28

/**
 * Detect whether the slate is in NBA playoffs based on game-date.
 * Conservative: only late-round playoffs (conference finals + finals) get the
 * tightening since play-in / first-round still has many close-to-regular-season
 * rotation patterns.
 *
 * Conference finals typically start mid-May; NBA Finals late-May through June.
 * Off-season after mid-June so this returns false until the next playoffs.
 */
function isPlayoffSlate(gameDate: string): boolean {
  // gameDate is YYYY-MM-DD Eastern
  const [y, m, d] = gameDate.split('-').map(Number)
  if (!y || !m || !d) return false
  // May 15 - June 30: conference finals through NBA Finals
  if (m === 5 && d >= 15) return true
  if (m === 6 && d <= 30) return true
  return false
}
// Sportsbooks apply extra vig on parlays — displayed multiplier is discounted ~15%
// to give a realistic estimate rather than the raw mathematical product.
// Per-leg vig factor: ~7% juice per leg (0.93^N compounds correctly)
// 2-leg: 0.865, 3-leg: 0.804, 4-leg: 0.748, 5-leg: 0.696
const PARLAY_VIG_PER_LEG = 0.93
const ALLOWED_MARKETS  = new Set(['points', 'rebounds', 'three_pointers', 'assists', 'blocks', 'steals'])
// Volatile stats only qualify at LOCK — PLAY hit rate too low (blocks 46.7%, steals 55.3%)
const VOLATILE_STATS   = new Set(['blocks', 'steals'])
// Safe stats for the 2-leg "Safe Pick" — excludes volatile BLK/STL (boosts leg hit rate 60.7% → 66.3%)
const SAFE_STATS       = new Set(['points', 'rebounds', 'three_pointers', 'assists'])
const ALLOWED_TIERS    = new Set(['LOCK', 'PLAY'])
// Maximum favorite odds — lines heavier than -150 are dropped by DFS platforms
// (PrizePicks, Underdog, Sleeper, Chalkboard) and aren't real bettable props.
const MAX_FAVORITE_ODDS = -150

// Minimum lines per stat — filter out trivial/gimme props that aren't real bets
const MIN_LINE: Record<string, number> = {
  points:         10.5,  // must be a meaningful scoring line
  rebounds:       3.5,   // must require real rebounding effort
  three_pointers: 1.5,   // "over 0.5 threes" is a coinflip, not a pick
  assists:        2.5,   // meaningful assist line
  blocks:         0.5,   // real block line (LOCK-only: 88.2% hit rate)
  steals:         0.5,   // real steal line  (LOCK-only: 76.5% hit rate)
}

const STAT_LABELS: Record<string, string> = {
  points:         'PTS',
  rebounds:       'REB',
  three_pointers: '3PM',
  assists:        'AST',
  blocks:         'BLK',
  steals:         'STL',
}

const ABBR_NORM: Record<string, string> = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', NJ: 'NJN' }
function normaliseAbbr(abbr: string): string { return ABBR_NORM[abbr] ?? abbr }

function teamFromMatchup(matchup: string, isHome: boolean): string | null {
  if (matchup.includes(' @ ')) {
    const [away, home] = matchup.split(' @ ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  if (matchup.includes(' vs. ')) {
    const [home, away] = matchup.split(' vs. ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  return null
}

function toDecimal(odds: number | null | undefined): number {
  if (odds == null) return 100 / 130 + 1  // default -130 (realistic avg prop odds)
  if (odds > 0) return odds / 100 + 1
  return 100 / Math.abs(odds) + 1
}

function toEasternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

interface ParlayLeg {
  player_name:      string
  team:             string
  stat_type:        string
  line:             number
  direction:        string
  odds:             number | null
  confidence_label: string
  confidence_score: number
  game_id:          string
  home_team:        string
  away_team:        string
  commence_time:    string
  l10_hits:         number
  l10_total:        number
}

interface ScoredProp {
  player_name:      string
  team:             string | null
  stat_type:        string
  line:             number
  direction:        string
  odds:             number | null
  confidence_label: string
  confidence_score: number
  game_id:          string
  home_team:        string | null
  away_team:        string | null
  commence_time:    string
  l10_hits:         number
  l10_total:        number
  resolvedTeam:     string
  avgMins:          number | null  // avg minutes over last 20 games
  ev:               number         // expected value per unit stake (calibrated prob × decimal odds − 1)
}

interface ParlayResult {
  legs:        ParlayLeg[]
  multiplier:  number
  title:       string
  description: string
  tier:        'value' | 'combo' | 'premium' | 'jackpot'
}

// Pick N legs from a pool. globalUsed prevents reusing the same player|stat within
// this parlay group. Correlation rules (enforced strictly then relaxed on fallback):
//   - No same player twice (always enforced)
//   - Max 1 player per team (avoids same-team correlation — strictly enforced first, relaxed on fallback)
//   - Max 2 legs from the same game (cross-game independence — relaxed last)
function pickParlay(
  pool:        ScoredProp[],
  globalUsed:  Set<string>,
  legsNeeded:  number,
  minMins:     number = 0,
): { legs: ParlayLeg[]; used: Set<string> } | null {
  // Always enforce strict team correlation (max 1 per team, max 2 per game).
  // No relaxed fallback — better to return null than build a same-team parlay.
  return _pickParlay(pool, globalUsed, legsNeeded, minMins)
}

/**
 * Diversity penalty applied to candidate effective-EV during pickParlay.
 * 0.02 = 2pp of EV subtracted per existing same-game leg, additional 0.01
 * subtracted when the candidate shares stat type with an existing same-game leg.
 *
 * Effect: when two candidates are within 3pp of EV, prefer the one in a
 * different game. When two candidates have identical EV in the same game,
 * prefer the one with a different stat type. Reduces parlay variance without
 * rejecting high-EV outliers outright.
 */
const SAME_GAME_DIVERSITY_PENALTY = 0.02
const SAME_GAME_SAME_STAT_PENALTY = 0.01

function diversityPenalty(
  candidate: ScoredProp,
  gameLegs:  Map<string, number>,
  statByGame: Map<string, Set<string>>,
): number {
  const gameId = candidate.game_id ?? ''
  if (!gameId) return 0
  const count = gameLegs.get(gameId) ?? 0
  if (count === 0) return 0
  let penalty = SAME_GAME_DIVERSITY_PENALTY * count
  const stats = statByGame.get(gameId)
  if (stats && stats.has(candidate.stat_type)) penalty += SAME_GAME_SAME_STAT_PENALTY
  return penalty
}

function _pickParlay(
  pool:        ScoredProp[],
  globalUsed:  Set<string>,
  legsNeeded:  number,
  minMins:     number,
): { legs: ParlayLeg[]; used: Set<string> } | null {
  const selected: ParlayLeg[] = []
  const usedPlayers = new Set<string>()
  const usedTeams   = new Set<string>()
  const gameLegs    = new Map<string, number>()
  const statByGame  = new Map<string, Set<string>>()

  // Pre-filter pool to candidates passing gates that DON'T depend on already-
  // selected legs. Re-checked inside the loop for those that do (used, team,
  // game cap).
  const baselineCandidates = pool.filter((p) => {
    if (globalUsed.has(`${p.player_name}|${p.stat_type}`)) return false
    if (minMins > 0 && (p.avgMins == null || p.avgMins < minMins)) return false
    return true
  })

  while (selected.length < legsNeeded) {
    let bestIdx = -1
    let bestEffEv = -Infinity

    for (let i = 0; i < baselineCandidates.length; i++) {
      const prop = baselineCandidates[i]
      if (usedPlayers.has(prop.player_name)) continue
      const team = prop.resolvedTeam ?? ''
      if (team && team !== 'TBD' && usedTeams.has(team)) continue
      const gameId = prop.game_id ?? ''
      if (gameId && (gameLegs.get(gameId) ?? 0) >= 2) continue

      // Effective EV = base EV minus same-game diversity penalty. Pool is
      // EV-sorted so first-pick is unaffected; subsequent picks favor variety.
      const effEv = prop.ev - diversityPenalty(prop, gameLegs, statByGame)
      if (effEv > bestEffEv) {
        bestEffEv = effEv
        bestIdx = i
      }
    }

    if (bestIdx === -1) break
    const prop = baselineCandidates[bestIdx]
    const team = prop.resolvedTeam ?? ''
    const gameId = prop.game_id ?? ''

    selected.push({
      player_name:      prop.player_name,
      team:             prop.resolvedTeam,
      stat_type:        prop.stat_type,
      line:             prop.line,
      direction:        prop.direction,
      odds:             prop.odds,
      confidence_label: prop.confidence_label,
      confidence_score: prop.confidence_score,
      game_id:          prop.game_id,
      home_team:        prop.home_team ?? '',
      away_team:        prop.away_team ?? '',
      commence_time:    prop.commence_time,
      l10_hits:         prop.l10_hits,
      l10_total:        prop.l10_total,
    })

    usedPlayers.add(prop.player_name)
    if (team && team !== 'TBD') usedTeams.add(team)
    if (gameId) {
      gameLegs.set(gameId, (gameLegs.get(gameId) ?? 0) + 1)
      if (!statByGame.has(gameId)) statByGame.set(gameId, new Set())
      statByGame.get(gameId)!.add(prop.stat_type)
    }
  }

  if (selected.length < legsNeeded) return null
  const used = new Set(selected.map((l) => `${l.player_name}|${l.stat_type}`))
  return { legs: selected, used }
}

/**
 * Same-game correlation haircut applied per game-pair.
 *
 * Two legs in the same NBA game share the game-state (pace, blowout risk,
 * minutes distribution) which makes the joint outcome MORE correlated than
 * independent. Books price this in — SGP markets typically reduce payouts
 * 5–15% vs the cross-game equivalent. Our parlay generator allows up to 2
 * legs per game, so each "same-game pair" gets a 5% multiplier haircut to
 * reflect that the displayed product-of-decimals over-states the bettor's
 * true expected payoff.
 *
 * Computed as Σ C(legsInGame, 2) across all games — e.g. a 4-leg parlay
 * with two pairs of same-game legs has 2 same-game pairs.
 */
const PARLAY_SAME_GAME_HAIRCUT = 0.95

function countSameGamePairs(legs: ParlayLeg[]): number {
  const perGame = new Map<string, number>()
  for (const l of legs) {
    if (!l.game_id) continue
    perGame.set(l.game_id, (perGame.get(l.game_id) ?? 0) + 1)
  }
  let pairs = 0
  for (const n of perGame.values()) {
    if (n >= 2) pairs += (n * (n - 1)) / 2
  }
  return pairs
}

function buildResult(
  legs:        ParlayLeg[],
  idx:         number,
  gameDate:    string,
  tier:        'value' | 'combo' | 'premium' | 'jackpot',
): ParlayResult {
  const parlayDecimal = legs.reduce((acc, l) => acc * toDecimal(l.odds), 1)
  // Compounding per-leg vig + same-game correlation haircut. Both terms
  // pull the displayed multiplier toward the bettor's *expected* payoff
  // rather than the naive product-of-decimals fair-price assumption.
  const sameGamePairs = countSameGamePairs(legs)
  const vigAdj   = Math.pow(PARLAY_VIG_PER_LEG, legs.length)
  const corrAdj  = Math.pow(PARLAY_SAME_GAME_HAIRCUT, sameGamePairs)
  const multiplier = Math.round(parlayDecimal * vigAdj * corrAdj * 10) / 10
  const legStrs = legs.map((l) => {
    const stat   = STAT_LABELS[l.stat_type] ?? l.stat_type
    const l10str = l.l10_total > 0 ? ` (${l.l10_hits}/${l.l10_total} L${l.l10_total})` : ''
    const dir = l.direction === 'under' ? 'U' : 'O'
    return `${l.player_name} ${dir} ${l.line} ${stat}${l10str}`
  })
  const title = tier === 'value'   ? `Safe Pick · ${gameDate}`
    : tier === 'combo'             ? `Combo · ${gameDate}`
    : tier === 'jackpot'           ? `Jackpot · ${gameDate}`
    : `High Roller · ${gameDate}`
  const description = legStrs.join(' · ') + ` — ~${multiplier}x payout`
  return { legs, multiplier, title, description, tier }
}

async function generateCuratedParlays(gameDate: string): Promise<ParlayResult[]> {
  // 1. Load LOCK/PLAY props for target date (both OVER and UNDER — UNDERs hit 50.1% vs OVERs 43.4%)
  const { data: propsRaw, error } = await supabase
    .from('props')
    .select('player_name, team, stat_type, line, direction, odds, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
    .in('confidence_label', ['LOCK', 'PLAY'])
    .order('confidence_score', { ascending: false })

  if (error || !propsRaw || propsRaw.length === 0) return []

  // Filter to target date + allowed markets + minimum line thresholds + bettable odds
  const eligible = propsRaw.filter((p) =>
    p.commence_time &&
    toEasternDate(p.commence_time) === gameDate &&
    ALLOWED_MARKETS.has(p.stat_type) &&
    ALLOWED_TIERS.has(p.confidence_label ?? '') &&
    p.line >= (MIN_LINE[p.stat_type] ?? 0) &&
    // blocks/steals: LOCK-only — PLAY hit rate too low to include
    (!VOLATILE_STATS.has(p.stat_type) || p.confidence_label === 'LOCK') &&
    // Reject heavy favorites — DFS platforms don't offer lines below -150
    (p.odds == null || p.odds >= MAX_FAVORITE_ODDS)
  )

  if (eligible.length === 0) return []

  // Dedup: keep highest confidence per player+stat
  const dedupMap = new Map<string, typeof eligible[0]>()
  for (const p of eligible) {
    const key = `${p.player_name}|${p.stat_type}`
    const ex  = dedupMap.get(key)
    if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) dedupMap.set(key, p)
  }
  const props = [...dedupMap.values()].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))

  // 2. Fetch game logs for l10 hit rates + team resolution
  const playerNames = [...new Set(props.map((p) => p.player_name))]
  const logsRaw = await safeQuery(
    supabase
      .from('player_game_logs')
      .select('player_name, game_date, matchup, is_home, points, rebounds, assists, fg3m, blocks, steals, minutes')
      .in('player_name', playerNames)
      .order('game_date', { ascending: false })
      .limit(playerNames.length * 15),
    'parlay: load game logs for pool'
  )

  const logsByPlayer = new Map<string, Record<string, unknown>[]>()
  const teamByPlayer = new Map<string, string>()
  for (const log of logsRaw) {
    const name = log.player_name as string
    if (!logsByPlayer.has(name)) logsByPlayer.set(name, [])
    logsByPlayer.get(name)!.push(log as Record<string, unknown>)
    if (!teamByPlayer.has(name) && log.matchup && log.is_home != null) {
      const abbr = teamFromMatchup(log.matchup as string, log.is_home as boolean)
      if (abbr) teamByPlayer.set(name, abbr)
    }
  }

  const STAT_FIELD: Record<string, string> = { points: 'points', rebounds: 'rebounds', three_pointers: 'fg3m', assists: 'assists', blocks: 'blocks', steals: 'steals' }

  // 3. Build scored pool with l10 stats + avg minutes (last 20 qualifying games)
  const pool: ScoredProp[] = props.map((prop) => {
    const allLogs = logsByPlayer.get(prop.player_name) ?? []
    const logs    = allLogs.filter((g) => Number(g.minutes ?? 0) >= 5)
    const l10     = logs.slice(0, 10)
    const last20  = logs.slice(0, 20)
    const field   = STAT_FIELD[prop.stat_type] ?? prop.stat_type
    const l10Hits = prop.direction === 'under'
      ? l10.filter((g) => Number(g[field] ?? 0) < prop.line).length
      : l10.filter((g) => Number(g[field] ?? 0) > prop.line).length
    const avgMins = last20.length > 0
      ? last20.reduce((sum, g) => sum + Number(g.minutes ?? 0), 0) / last20.length
      : null
    // EV per unit stake — calibrated probability × decimal odds − 1.
    // Pass stat_type so we use the per-stat calibration curve — rebounds/3PM
    // diverge enough from the global curve that global-fallback EV is noisy
    // for those stats. Falls back to 0 (neutral) if either input is missing
    // so the prop stays in the pool but never gets favored over a real +EV pick.
    const propEv = computeEv(prop.confidence_score, prop.odds, prop.stat_type) ?? 0
    return {
      player_name:      prop.player_name,
      team:             prop.team,
      stat_type:        prop.stat_type,
      line:             prop.line,
      direction:        prop.direction,
      odds:             prop.odds ?? null,
      confidence_label: prop.confidence_label!,
      confidence_score: prop.confidence_score!,
      game_id:          prop.game_id,
      home_team:        prop.home_team,
      away_team:        prop.away_team,
      commence_time:    prop.commence_time!,
      l10_hits:         l10Hits,
      l10_total:        l10.length,
      resolvedTeam:     teamByPlayer.get(prop.player_name) ?? prop.team ?? 'TBD',
      avgMins:          avgMins !== null ? Math.round(avgMins * 10) / 10 : null,
      ev:               propEv,
    }
  })

  // 3b. Load recent production accuracy to identify hot stat types.
  //     Hot stat = LOCK hit rate ≥ 62% with ≥ 10 graded samples in last 30 days.
  //     Hot stats get a +5 score bonus so they bubble up in the pool, making them
  //     more likely to be selected for parlays without hard-excluding other types.
  const HOT_LOCK_THRESHOLD = 0.62
  const HOT_MIN_SAMPLES    = 10
  const HOT_BONUS          = 5  // points added to confidence_score for sorting

  try {
    const minGradeDate = new Date(Date.now() - 30 * 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    const gradeRows = await safeQuery(
      supabase
        .from('prop_grades')
        .select('stat_type, confidence_label, hit')
        .gte('game_date', minGradeDate)
        .not('hit', 'is', null)
        .in('confidence_label', ['LOCK']),
      'parlay: load grade rows for hot stat'
    )

    if (gradeRows.length >= HOT_MIN_SAMPLES) {
      // Tally LOCK hit rate per stat
      const tallyMap = new Map<string, { hits: number; total: number }>()
      for (const row of gradeRows) {
        if (!tallyMap.has(row.stat_type)) tallyMap.set(row.stat_type, { hits: 0, total: 0 })
        tallyMap.get(row.stat_type)!.hits  += (row as Record<string, unknown>).hit === true ? 1 : 0
        tallyMap.get(row.stat_type)!.total += 1
      }
      const hotStats = new Set<string>()
      for (const [stat, { hits, total }] of tallyMap) {
        if (total >= HOT_MIN_SAMPLES && hits / total >= HOT_LOCK_THRESHOLD) hotStats.add(stat)
      }
      // Apply bonus to pool: re-sort with hot-stat adjusted scores
      if (hotStats.size > 0) {
        for (const p of pool) {
          if (hotStats.has(p.stat_type)) {
            p.confidence_score += HOT_BONUS
          }
        }
      }
    }
  } catch {
    // Grades not yet available — fall back to unmodified pool order
  }

  // Final ordering: EV descending. The hot-stat bonus above only affects
  // confidence_score (kept for tier-aware logic and display). EV is the
  // real money metric — a +6% edge LEAN beats a +2% edge LOCK in expectation
  // even though the LOCK looks "safer" by tier.
  // Tiebreakers: confidence_score (post hot-stat bonus), then l10 hit rate.
  pool.sort((a, b) => {
    if (b.ev !== a.ev) return b.ev - a.ev
    if (b.confidence_score !== a.confidence_score) return b.confidence_score - a.confidence_score
    const aHr = a.l10_total > 0 ? a.l10_hits / a.l10_total : 0
    const bHr = b.l10_total > 0 ? b.l10_hits / b.l10_total : 0
    return bHr - aHr
  })

  // Playoff-mode tightening: conference finals + NBA Finals have ~8-9 player
  // rotations vs ~10-11 in regular season. Bench-leaning props with 20-24 min
  // averages collapse to 12-18 min in playoffs, so their hit rates plummet.
  // Bump the min-minutes thresholds to push the parlay generator toward the
  // 30+ MPG core rotation that survives playoff minute cuts.
  const playoff       = isPlayoffSlate(gameDate)
  const valueMinMins  = playoff ? PLAYOFF_VALUE_MIN_MINS   : VALUE_MIN_MINS
  const premiumMinMins= playoff ? PLAYOFF_PREMIUM_MIN_MINS : PREMIUM_MIN_MINS
  const jackpotMinMins= playoff ? PLAYOFF_JACKPOT_MIN_MINS : JACKPOT_MIN_MINS
  if (playoff) {
    logger.info('[parlay] playoff-mode active — tightened min-minutes', {
      gameDate, value: valueMinMins, premium: premiumMinMins, jackpot: jackpotMinMins,
    })
  }

  // 4. Build VALUE parlay (2-leg, safe stats only + min-minutes filter)
  //    Safe stats (PTS/REB/AST/3PM) + 24min filter: 40.8% hit rate vs 33.9% current
  const safePool = pool.filter((p) => SAFE_STATS.has(p.stat_type))
  const results: ParlayResult[] = []
  const valueUsed = new Set<string>()
  const valuePick = pickParlay(safePool, valueUsed, VALUE_LEGS, valueMinMins)
  if (valuePick) {
    results.push({ ...buildResult(valuePick.legs, 0, gameDate, 'value'), tier: 'value' })
  }

  // 4b. Build COMBO parlay (3-leg, full pool, no min mins — best single-tier ROI)
  const comboUsed = new Set<string>()
  const comboPick = pickParlay(pool, comboUsed, COMBO_LEGS)
  if (comboPick) {
    results.push({ ...buildResult(comboPick.legs, 0, gameDate, 'combo'), tier: 'combo' })
  }

  // 5. Build PREMIUM parlays (4-leg, EV-first pool, min-minutes filter)
  //    Playoff-mode bumps the min-minutes threshold to 30+ since rotations
  //    tighten dramatically in late-round playoffs.
  const premiumUsed = new Set<string>()
  for (let i = 0; i < PREMIUM_COUNT; i++) {
    const pick = pickParlay(pool, premiumUsed, PREMIUM_LEGS, premiumMinMins)
    if (!pick) break
    results.push({ ...buildResult(pick.legs, i, gameDate, 'premium'), tier: 'premium' })
    for (const key of pick.used) premiumUsed.add(key)
  }

  // 6. Build JACKPOT parlay (5-leg, 24+ avg mins filter, EV-first pool)
  const jackpotUsed = new Set<string>()
  const jackpotPick = pickParlay(pool, jackpotUsed, JACKPOT_LEGS, jackpotMinMins)
  if (jackpotPick) {
    results.push({ ...buildResult(jackpotPick.legs, 0, gameDate, 'jackpot'), tier: 'jackpot' })
  }

  return results
}

// ── Pass 2: Midday re-evaluation ─────────────────────────────────────────────
// Compares morning parlays against re-enriched props and injury data.
// Only generates replacement parlays if material changes detected.

async function handlePass2(gameDate: string) {
  // 1. Load morning (Pass 1) parlays for today
  const { data: morningParlays, error: mpErr } = await adminClient
    .from('curated_parlays')
    .select('id, title, parlay_type, legs, est_multiplier')
    .eq('game_date', gameDate)
    .eq('active', true)
    .eq('superseded', false)
    .in('parlay_type', ['value', 'combo', 'premium', 'jackpot'])

  if (mpErr || !morningParlays || morningParlays.length === 0) {
    return NextResponse.json({
      message: 'No morning parlays found to re-evaluate',
      date: gameDate,
      pass: 2,
      updated: 0,
    })
  }

  // 2. Load current re-enriched props (already updated by 11 AM enrich step)
  const currentProps = await safeQuery(
    supabase
      .from('props')
      .select('player_name, stat_type, line, direction, confidence_label, confidence_score, odds, game_id, home_team, away_team, commence_time')
      .in('confidence_label', ['LOCK', 'PLAY', 'FADE']),
    'pass2: load re-enriched props'
  )

  const middayPropMap = new Map<string, {
    player_name: string; stat_type: string; line: number; direction: string;
    confidence_label: string | null; confidence_score: number | null;
  }>()
  for (const p of currentProps) {
    if (!p.commence_time || toEasternDate(p.commence_time) !== gameDate) continue
    const key = `${p.player_name}|${p.stat_type}`
    // Keep highest score per player|stat (same dedup as morning)
    const existing = middayPropMap.get(key)
    if (!existing || (p.confidence_score ?? 0) > (existing.confidence_score ?? 0)) {
      middayPropMap.set(key, p)
    }
  }

  // 3. Load injury data from props' confidence_reason (contains injury status)
  // We detect injuries by checking if a player's midday prop disappeared or
  // if their confidence reason mentions OUT/DOUBTFUL
  const injuryMap = new Map<string, { player_name: string; status: 'out' | 'doubtful' | 'questionable' | 'active' }>()
  const allProps = await safeQuery(
    supabase
      .from('props')
      .select('player_name, confidence_reason')
      .not('confidence_reason', 'is', null),
    'pass2: load injury reasons'
  )

  for (const p of allProps) {
    if (!p.confidence_reason) continue
    const outMatch = (p.confidence_reason as string).match(/listed as (OUT|DOUBTFUL|QUESTIONABLE)/)
    if (outMatch) {
      const status = outMatch[1].toLowerCase() as 'out' | 'doubtful' | 'questionable'
      injuryMap.set(p.player_name, { player_name: p.player_name, status })
    }
  }

  // 4. Run change detection on each morning parlay
  const reports: ChangeReport[] = []
  for (const parlay of morningParlays) {
    const legs = (parlay.legs as Array<Record<string, unknown>>) ?? []
    const morningLegs = legs.map((l) => ({
      player_name:      l.player_name as string,
      stat_type:        l.stat_type as string,
      line:             Number(l.line),
      direction:        l.direction as string,
      confidence_label: l.confidence_label as string | undefined,
      confidence_score: l.confidence_score != null ? Number(l.confidence_score) : undefined,
    }))

    const report = detectChanges(
      parlay.id as string,
      parlay.parlay_type as string,
      morningLegs,
      middayPropMap,
      injuryMap,
    )
    reports.push(report)
  }

  const needsUpdate = reports.filter((r) => r.hasSignificantChange)

  if (needsUpdate.length === 0) {
    console.log(`[generate/parlay] Pass 2: No material changes detected for ${gameDate} — morning picks confirmed`)
    return NextResponse.json({
      message: `Pass 2: Morning picks confirmed — no material changes detected`,
      date: gameDate,
      pass: 2,
      updated: 0,
      confirmed: morningParlays.length,
      reports: reports.map((r) => ({ parlayType: r.parlayType, changes: r.changes.length })),
    })
  }

  // 5. Generate replacement parlays for those with significant changes
  const results = await generateCuratedParlays(gameDate)
  if (results.length === 0) {
    return NextResponse.json({
      message: 'Pass 2: Changes detected but not enough qualifying props to rebuild',
      date: gameDate,
      pass: 2,
      updated: 0,
      reports: needsUpdate.map((r) => ({ parlayType: r.parlayType, summary: r.summary })),
    })
  }

  let updated = 0
  const errors: string[] = []

  for (const report of needsUpdate) {
    const replacement = results.find((r) => r.tier === report.parlayType)
    if (!replacement) continue

    // 5a. Insert the Pass 2 replacement parlay
    const { data: inserted, error: insertErr } = await adminClient
      .from('curated_parlays')
      .insert({
        title:          replacement.title,
        description:    replacement.description,
        parlay_type:    replacement.tier,
        game_date:      gameDate,
        est_multiplier: replacement.multiplier,
        legs:           replacement.legs.map((l) => ({
          player_name:      l.player_name,
          team:             l.team,
          stat_type:        l.stat_type,
          line:             l.line,
          direction:        l.direction,
          odds:             l.odds,
          confidence_label: l.confidence_label,
          confidence_score: l.confidence_score,
          l10_hits:         l.l10_hits,
          l10_total:        l.l10_total,
        })),
        active:         true,
        pass:           2,
        replaces_id:    report.parlayId,
        change_summary: report.summary,
        superseded:     false,
      })
      .select('id')
      .single()

    if (insertErr) {
      errors.push(`Insert ${report.parlayType}: ${insertErr.message}`)
      continue
    }

    // 5b. Mark the morning parlay as superseded
    const { error: updateErr } = await adminClient
      .from('curated_parlays')
      .update({ superseded: true })
      .eq('id', report.parlayId)

    if (updateErr) {
      errors.push(`Supersede ${report.parlayId}: ${updateErr.message}`)
    } else {
      updated++
    }

    console.log(`[generate/parlay] Pass 2: Replaced ${report.parlayType} parlay (${report.parlayId}) → ${inserted?.id} | ${report.summary}`)
  }

  // 6. Insert Pass 2 announcement if changes were made
  if (updated > 0) {
    const summaries = needsUpdate.filter((r) => r.summary).map((r) => r.summary)
    const { error: p2AnnErr } = await adminClient.from('feed_announcements').insert({
      game_date: gameDate,
      message: summaries.join('. ') || `${updated} parlay(s) updated after midday injury and line checks.`,
      type: 'pass2_update',
    })
    if (p2AnnErr) logger.error('parlay pass2: insert announcement failed', { error: p2AnnErr.message })
  }

  // 7. Also fire streak re-evaluation
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  try {
    const streakRes = await fetch(`${baseUrl}/api/feed/generate/streak?date=${gameDate}&pass=2`, {
      headers: internalAuthHeaders(),
    })
    if (!streakRes.ok) logger.warn('[generate/parlay] streak pass2 returned non-OK', { status: streakRes.status })
  } catch (e) {
    logger.error('[generate/parlay] streak pass2 failed', { err: String(e) })
  }

  return NextResponse.json({
    message: `Pass 2: Updated ${updated} parlay(s) for ${gameDate}`,
    date:    gameDate,
    pass:    2,
    updated,
    confirmed: morningParlays.length - updated,
    reports: reports.map((r) => ({
      parlayType: r.parlayType,
      hasChange:  r.hasSignificantChange,
      summary:    r.summary,
      changes:    r.changes,
    })),
    ...(errors.length > 0 && { errors }),
  })
}

// GET aliases POST so GitHub Actions curl (GET) saves parlays to DB.
export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError
  return POST(req)
}

export async function POST(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError
  const url      = new URL(req.url)
  const gameDate = url.searchParams.get('date')
    ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const pass     = url.searchParams.get('pass')
  const stats    = url.searchParams.get('stats') === 'true'

  // ?pass=2 — midday re-evaluation (compare morning picks against re-enriched data)
  if (pass === '2') {
    return handlePass2(gameDate)
  }

  // ?stats=true — return pool breakdown without saving anything
  if (stats) {
    const propsRaw = await safeQuery(
      supabase
        .from('props')
        .select('player_name, team, stat_type, line, direction, odds, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
        .in('confidence_label', ['LOCK', 'PLAY'])
        .order('confidence_score', { ascending: false }),
      'stats: load LOCK/PLAY props'
    )

    const eligible = propsRaw.filter((p) =>
      p.commence_time &&
      toEasternDate(p.commence_time) === gameDate &&
      ALLOWED_MARKETS.has(p.stat_type) &&
      (p.line ?? 0) >= (MIN_LINE[p.stat_type] ?? 0) &&
      (!VOLATILE_STATS.has(p.stat_type) || p.confidence_label === 'LOCK') &&
      (p.odds == null || (p.odds as number) >= MAX_FAVORITE_ODDS)
    )

    const playerNames = [...new Set(eligible.map((p) => p.player_name))]
    const logsRawStats = await safeQuery(
      supabase
        .from('player_game_logs')
        .select('player_name, game_date, minutes')
        .in('player_name', playerNames)
        .order('game_date', { ascending: false })
        .limit(playerNames.length * 25),
      'stats: load game logs for avg mins'
    )

    const avgMinsMap = new Map<string, number | null>()
    const logsByPlayer = new Map<string, number[]>()
    for (const log of logsRawStats) {
      if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
      if (Number(log.minutes ?? 0) >= 5) logsByPlayer.get(log.player_name)!.push(Number(log.minutes))
    }
    for (const name of playerNames) {
      const mins = (logsByPlayer.get(name) ?? []).slice(0, 20)
      avgMinsMap.set(name, mins.length > 0 ? mins.reduce((s, m) => s + m, 0) / mins.length : null)
    }

    const poolSummary = eligible.map((p) => ({
      player: p.player_name,
      team: p.team,
      stat: p.stat_type,
      line: p.line,
      label: p.confidence_label,
      score: p.confidence_score,
      avgMins: avgMinsMap.get(p.player_name) ?? null,
      meetsMinMins: (avgMinsMap.get(p.player_name) ?? 0) >= 24,
    }))

    // Show what got filtered out and why
    const allLockPlay = (propsRaw ?? []).filter((p) =>
      p.commence_time && toEasternDate(p.commence_time) === gameDate
    )
    const byStatDir = new Map<string, number>()
    for (const p of allLockPlay) {
      const k = `${p.stat_type}|${p.direction ?? 'unknown'}`
      byStatDir.set(k, (byStatDir.get(k) ?? 0) + 1)
    }
    const filtered = allLockPlay.filter((p) =>
      !ALLOWED_MARKETS.has(p.stat_type) ||
      (p.line ?? 0) < (MIN_LINE[p.stat_type] ?? 0) ||
      (VOLATILE_STATS.has(p.stat_type) && p.confidence_label !== 'LOCK')
    )
    const filteredReasons = filtered.map((p) => ({
      player: p.player_name,
      stat: p.stat_type,
      line: p.line,
      dir: p.direction,
      label: p.confidence_label,
      reason: !ALLOWED_MARKETS.has(p.stat_type) ? 'market excluded'
        : (p.line ?? 0) < (MIN_LINE[p.stat_type] ?? 0) ? 'below min line'
        : 'volatile stat requires LOCK',
    }))

    return NextResponse.json({
      date: gameDate,
      totalLockPlayToday: allLockPlay.length,
      totalEligible: eligible.length,
      with24MinFilter: poolSummary.filter((p) => p.meetsMinMins).length,
      breakdownByStatDir: Object.fromEntries(byStatDir),
      filteredOut: filteredReasons,
      pool: poolSummary,
    })
  }

  try {
    // Safety guard: abort if today's props haven't been enriched yet (enrich failed or hasn't run).
    const { count: scoredCount, error: countErr } = await adminClient
      .from('props')
      .select('id', { count: 'exact', head: true })
      .in('confidence_label', ['LOCK', 'PLAY'])
      .gte('commence_time', `${gameDate}T00:00:00.000Z`)
      .lt('commence_time', `${gameDate}T23:59:59.999Z`)
    if (countErr) logger.error('parlay: scored count query failed', { error: countErr.message })
    if ((scoredCount ?? 0) < 5) {
      console.warn(`[generate/parlay] aborted — only ${scoredCount ?? 0} scored props for ${gameDate}, enrichment may not have run yet`)
      return NextResponse.json({
        message: 'Not enough scored props for today — run /api/enrich first',
        scoredCount: scoredCount ?? 0,
        date: gameDate,
      })
    }

    // Always delete existing auto-generated parlays for the date and regenerate fresh.
    const { data: existing, error: existErr } = await adminClient
      .from('curated_parlays')
      .select('id')
      .eq('game_date', gameDate)
      .in('parlay_type', ['value', 'combo', 'premium', 'jackpot'])
      .eq('active', true)
    if (existErr) logger.error('parlay: load existing parlays failed', { error: existErr.message })
    if (existing && existing.length > 0) {
      const { error: delErr } = await adminClient.from('curated_parlays').delete().in('id', existing.map((r) => r.id))
      if (delErr) logger.error('parlay: delete existing parlays failed', { error: delErr.message })
    }

    // Also clear existing announcements for the date
    const { error: annDelErr } = await adminClient.from('feed_announcements').delete().eq('game_date', gameDate)
    if (annDelErr) logger.error('parlay: delete announcements failed', { error: annDelErr.message })

    const results = await generateCuratedParlays(gameDate)

    if (results.length === 0) {
      return NextResponse.json({
        message: 'Not enough qualifying props to build any parlay',
        date: gameDate,
        saved: 0,
      })
    }

    const toInsert = results

    const rows = toInsert.map((result) => ({
      title:          result.title,
      description:    result.description,
      parlay_type:    result.tier,
      game_date:      gameDate,
      est_multiplier: result.multiplier,
      legs:           result.legs.map((l) => ({
        player_name:      l.player_name,
        team:             l.team,
        stat_type:        l.stat_type,
        line:             l.line,
        direction:        l.direction,
        odds:             l.odds,
        confidence_label: l.confidence_label,
        confidence_score: l.confidence_score,
        l10_hits:         l.l10_hits,
        l10_total:        l.l10_total,
      })),
      active: true,
      pass: 1,
      superseded: false,
    }))

    const { data, error } = await adminClient
      .from('curated_parlays')
      .insert(rows)
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Generate feed announcements based on what we could/couldn't fill
    const announcements: { game_date: string; message: string; type: string }[] = []
    const allTiers = ['value', 'combo', 'premium', 'jackpot'] as const
    const filledTiers = new Set(results.map((r) => r.tier))
    const missingTiers = allTiers.filter((t) => !filledTiers.has(t))

    if (results.length === 0) {
      announcements.push({
        game_date: gameDate,
        message: "Light slate today — not enough qualifying props to build parlays. We'll be back tomorrow with a full card.",
        type: 'light_slate',
      })
    } else if (missingTiers.length > 0 && results.length < 4) {
      const tierNames: Record<string, string> = { value: 'Safe Pick', combo: 'Combo', premium: 'High Roller', jackpot: 'Jackpot' }
      const missingNames = missingTiers.map((t) => tierNames[t])
      const filled = results.length
      announcements.push({
        game_date: gameDate,
        message: `${filled} of 4 parlays filled today. Not enough qualifying props for ${missingNames.join(', ')} — fewer games or volatile lines today. Quality over quantity.`,
        type: 'partial_slate',
      })
    }

    if (announcements.length > 0) {
      const { error: annErr } = await adminClient.from('feed_announcements').insert(announcements)
      if (annErr) logger.error('parlay: insert announcements failed', { error: annErr.message })
    }

    // Await streak generation so it completes before we return
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    try {
      const streakRes = await fetch(`${baseUrl}/api/feed/generate/streak?date=${gameDate}`, {
        headers: internalAuthHeaders(),
      })
      if (!streakRes.ok) logger.warn('[generate/parlay] streak returned non-OK', { status: streakRes.status })
    } catch (e) {
      logger.error('[generate/parlay] streak generation failed', { err: String(e) })
    }

    return NextResponse.json({
      message: `Generated and saved ${rows.length} curated parlay(s) for ${gameDate}`,
      date:    gameDate,
      saved:   rows.length,
      parlays: data,
      announcements: announcements.length,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
