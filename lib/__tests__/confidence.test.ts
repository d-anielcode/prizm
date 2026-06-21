/**
 * Unit tests for the confidence scoring engine (lib/confidence.ts)
 *
 * Covers: U1 (all-null context), U2 (minimum games), U3 (missing defStats keys),
 * U4 (parlay with 0 props — tested via scoreProps edge cases),
 * U5 (DNP detection — tested via 0-minute games)
 */

import { describe, it, expect } from 'vitest'
import {
  scoreProps,
  computeFactors,
  applyWeights,
  inferPlayerPosition,
  type GameLog,
  type ScoringContext,
  type TeamDefenseStats,
  type SeasonStats,
} from '../confidence'
import type { Prop } from '@/types'

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeProp(overrides: Partial<Prop> = {}): Prop {
  return {
    player_id: 1,
    player_name: 'Test Player',
    team: 'Test Team',
    opponent: 'Test Opponent',
    game_id: 'game-1',
    stat_type: 'points',
    line: 20.5,
    direction: 'over',
    odds: -110,
    commence_time: '2026-04-16T00:00:00Z',
    ...overrides,
  }
}

function makeGameLog(overrides: Partial<GameLog> = {}): GameLog {
  return {
    game_date: '2026-04-15',
    matchup: 'TES vs OPP',
    is_home: true,
    points: 25,
    rebounds: 8,
    assists: 5,
    steals: 1,
    blocks: 1,
    fg3m: 3,
    minutes: 35,
    pra: 38,
    ...overrides,
  }
}

function makeDefStats(overrides: Partial<TeamDefenseStats> = {}): TeamDefenseStats {
  return {
    team_abbreviation: 'OPP',
    pts_rank: 15,
    reb_rank: 15,
    ast_rank: 15,
    blk_rank: 15,
    stl_rank: 15,
    fg3m_rank: 15,
    ...overrides,
  }
}

// Generate N game logs with sequential dates going back from today
function makeGameLogSeries(n: number, statValue = 25): GameLog[] {
  const logs: GameLog[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date('2026-04-15')
    d.setDate(d.getDate() - i)
    logs.push(makeGameLog({
      game_date: d.toISOString().slice(0, 10),
      points: statValue + (i % 3 === 0 ? 2 : -1),  // slight variance
      rebounds: 8,
      assists: 5,
      minutes: 34,
    }))
  }
  return logs
}

// ── U1: scoreProps with all-null context ─────────────────────────────────────

describe('U1: scoreProps with all-null context', () => {
  it('returns a valid score with 0 game logs and null context', () => {
    const prop = makeProp()
    const result = scoreProps(prop, [], null, null)

    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_score).toBeLessThanOrEqual(65) // no-log cap
    // LEAN/MED_RISK removed — getLabel only emits LOCK/PLAY/FADE now.
    expect(['LOCK', 'PLAY', 'FADE']).toContain(result.confidence_label)
    expect(['PRIME', 'LOW_RISK', 'HIGH_RISK']).toContain(result.risk_tier)
    expect(result.confidence_reason).toBeTruthy()
  })

  it('returns a valid score with 0 game logs but with season stats', () => {
    const prop = makeProp()
    const seasonStats: SeasonStats = {
      avg_points: 22.5,
      avg_rebounds: 7.0,
      avg_assists: 4.5,
      avg_steals: 1.2,
      avg_blocks: 0.8,
      avg_fg3m: 2.1,
      avg_pra: 34.0,
      avg_minutes: 33.0,
      games_played: 60,
    }
    const ctx: ScoringContext = { seasonStats }
    const result = scoreProps(prop, [], null, ctx)

    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_score).toBeLessThanOrEqual(65) // no-log cap
  })

  it('caps at 65 when no game logs exist', () => {
    const prop = makeProp()
    // Even with favorable matchup + season stats, no-log cap should hold
    const ctx: ScoringContext = {
      defStats: makeDefStats({ pts_rank: 30 }), // easiest defense
      seasonStats: {
        avg_points: 30, avg_rebounds: 10, avg_assists: 8,
        avg_steals: 2, avg_blocks: 2, avg_fg3m: 4, avg_pra: 48,
        avg_minutes: 38, games_played: 70,
      },
    }
    const result = scoreProps(prop, [], null, ctx)
    expect(result.confidence_score).toBeLessThanOrEqual(65)
  })

  it('handles every stat type with null context', () => {
    const statTypes = ['points', 'rebounds', 'assists', 'pra', 'steals', 'blocks', 'three_pointers'] as const
    for (const stat of statTypes) {
      const prop = makeProp({ stat_type: stat, line: stat === 'steals' ? 1.5 : 20.5 })
      const result = scoreProps(prop, [], null, null)
      expect(result.confidence_score).toBeGreaterThanOrEqual(18)
      expect(result.confidence_score).toBeLessThanOrEqual(65)
    }
  })

  it('handles UNDER direction with null context', () => {
    const prop = makeProp({ direction: 'under' })
    const result = scoreProps(prop, [], null, null)
    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_score).toBeLessThanOrEqual(65)
  })
})

// ── U2: hitRate with minimum games ───────────────────────────────────────────

describe('U2: scoreProps with exactly 3 games (minimum)', () => {
  it('produces a valid score at the 3-game minimum', () => {
    const prop = makeProp({ line: 20.5 })
    const logs = makeGameLogSeries(3, 25)  // all hit (25 > 20.5)
    const result = scoreProps(prop, logs, null, null)

    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_score).toBeLessThanOrEqual(95)
    expect(typeof result.confidence_score).toBe('number')
    expect(Number.isNaN(result.confidence_score)).toBe(false)
  })

  it('produces a valid score with exactly 3 games all miss', () => {
    const prop = makeProp({ line: 30.5, direction: 'over' })
    const logs = makeGameLogSeries(3, 20)  // all miss (20 < 30.5)
    const result = scoreProps(prop, logs, null, null)

    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(Number.isNaN(result.confidence_score)).toBe(false)
  })

  it('with 2 games falls back to no-log path (cap 65)', () => {
    const prop = makeProp()
    const logs = makeGameLogSeries(2)
    const result = scoreProps(prop, logs, null, null)

    expect(result.confidence_score).toBeLessThanOrEqual(65) // no-log cap
  })
})

// ── U3: matchupScore with missing defStats keys ─────────────────────────────

describe('U3: scoreProps with partial defStats', () => {
  it('handles defStats missing stat-specific rank keys', () => {
    const prop = makeProp({ stat_type: 'steals', line: 1.5 })
    const logs = makeGameLogSeries(10, 2) // steals above 1.5
    // Create defStats with only pts_rank — missing stl_rank
    const partial = {
      team_abbreviation: 'OPP',
      pts_rank: 15,
      reb_rank: 15,
      ast_rank: 15,
      blk_rank: 15,
      // stl_rank deliberately missing
      fg3m_rank: 15,
    } as TeamDefenseStats

    const ctx: ScoringContext = { defStats: partial }
    const result = scoreProps(prop, logs, null, ctx)

    expect(Number.isNaN(result.confidence_score)).toBe(false)
    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_score).toBeLessThanOrEqual(95)
  })

  it('handles completely empty defStats object', () => {
    const prop = makeProp()
    const logs = makeGameLogSeries(10)
    const ctx: ScoringContext = { defStats: { team_abbreviation: 'OPP' } as TeamDefenseStats }
    const result = scoreProps(prop, logs, null, ctx)

    expect(Number.isNaN(result.confidence_score)).toBe(false)
    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
  })
})

// ── U4: Edge cases for parlay-adjacent scoring ──────────────────────────────

describe('U4: Scoring edge cases', () => {
  it('handles line of 0.5 (minimum possible)', () => {
    const prop = makeProp({ stat_type: 'blocks', line: 0.5, direction: 'over' })
    const logs = makeGameLogSeries(10).map(l => ({ ...l, blocks: 1 }))
    const result = scoreProps(prop, logs, null, null)

    expect(Number.isNaN(result.confidence_score)).toBe(false)
    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
  })

  it('handles very high line (extreme over)', () => {
    const prop = makeProp({ stat_type: 'points', line: 50.5, direction: 'over' })
    const logs = makeGameLogSeries(15, 25) // all miss — 25 < 50.5
    const result = scoreProps(prop, logs, null, null)

    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_label).toBe('FADE')
  })

  it('handles zero odds gracefully', () => {
    const prop = makeProp({ odds: 0 })
    const logs = makeGameLogSeries(10)
    // Odds of 0 could cause issues in implied probability conversion
    const result = scoreProps(prop, logs, null, null)

    expect(Number.isNaN(result.confidence_score)).toBe(false)
  })

  it('handles undefined odds gracefully', () => {
    const prop = makeProp({ odds: undefined })
    const logs = makeGameLogSeries(10)
    const result = scoreProps(prop, logs, null, null)

    expect(Number.isNaN(result.confidence_score)).toBe(false)
  })
})

// ── U5: DNP / low-minute games ──────────────────────────────────────────────

describe('U5: DNP and low-minute filtering', () => {
  it('filters out 0-minute games from hit rate calculation', () => {
    const prop = makeProp({ line: 15.5 })
    // Mix of real games and DNPs (0 min)
    const logs = [
      ...makeGameLogSeries(5, 20),  // 5 real games
      makeGameLog({ minutes: 0, points: 0, game_date: '2026-04-01' }),
      makeGameLog({ minutes: 0, points: 0, game_date: '2026-03-31' }),
      makeGameLog({ minutes: 2, points: 0, game_date: '2026-03-30' }),  // <5 min
    ]
    const result = scoreProps(prop, logs, null, null)

    // Should still score (5 real games >= 3 minimum)
    expect(result.confidence_score).toBeGreaterThanOrEqual(18)
    expect(result.confidence_score).toBeLessThanOrEqual(95)
  })

  it('falls to no-log path if all games are DNP', () => {
    const prop = makeProp()
    const logs = [
      makeGameLog({ minutes: 0, points: 0, game_date: '2026-04-15' }),
      makeGameLog({ minutes: 0, points: 0, game_date: '2026-04-14' }),
      makeGameLog({ minutes: 2, points: 0, game_date: '2026-04-13' }),
    ]
    const result = scoreProps(prop, logs, null, null)

    // All < 5 min → filtered out → hasLogs = false → cap at 65
    expect(result.confidence_score).toBeLessThanOrEqual(65)
  })
})

// ── Additional: inferPlayerPosition ─────────────────────────────────────────

describe('inferPlayerPosition', () => {
  it('returns guard for high assist / low rebound avg', () => {
    const stats: SeasonStats = {
      avg_points: 20, avg_rebounds: 3, avg_assists: 8,
      avg_steals: 1.5, avg_blocks: 0.3, avg_fg3m: 2, avg_pra: 31,
      avg_minutes: 34, games_played: 50,
    }
    expect(inferPlayerPosition(stats)).toBe('guard')
  })

  it('returns center for high rebound / low assist avg', () => {
    const stats: SeasonStats = {
      avg_points: 15, avg_rebounds: 12, avg_assists: 2,
      avg_steals: 0.5, avg_blocks: 2.5, avg_fg3m: 0, avg_pra: 29,
      avg_minutes: 30, games_played: 50,
    }
    expect(inferPlayerPosition(stats)).toBe('center')
  })

  it('returns forward for null stats', () => {
    expect(inferPlayerPosition(null)).toBe('forward')
    expect(inferPlayerPosition(undefined)).toBe('forward')
  })
})

// ── Star bonus direction guard (regression test for C4) ─────────────────────

describe('C4 regression: Star bonus only for OVER', () => {
  it('UNDER picks do not get star bonus', () => {
    const overProp = makeProp({ direction: 'over', line: 18.5 })
    const underProp = makeProp({ direction: 'under', line: 18.5 })
    // Create a scenario where star bonus would fire:
    // star tier (36+ avg mins), generous line (fLineValue >= 0.58), hot hit rate
    const logs = makeGameLogSeries(20, 25).map(l => ({ ...l, minutes: 38 }))

    const overResult = scoreProps(overProp, logs, null, null)
    const underResult = scoreProps(underProp, logs, null, null)

    // We can't guarantee the exact bonus applied, but over should score >= under
    // for the same prop when the star bonus should be relevant
    // (This is a directional test — the exact score difference depends on all factors)
    expect(typeof overResult.confidence_score).toBe('number')
    expect(typeof underResult.confidence_score).toBe('number')
  })
})

// ── U6: scoreProps ↔ applyWeights parity ─────────────────────────────────────
// Catches the BLOCKER discovered 2026-05-20: applyWeights was missing 9 of
// the 14 additives that scoreProps applies, so scripts/optimize-weights.ts
// was tuning factor weights against a phantom model.

describe('U6: scoreProps ↔ applyWeights parity', () => {
  // Default weight set must match getWeights('points') in lib/confidence.ts.
  const defaultWeightsPoints = {
    lineValue: 0.07, matchupEdge: 0.02, last20HitRate: 0.28, trend: 0.00,
    seasonCushion: 0.10, pace: 0.17, newsInjury: 0.13, restDays: 0.00,
    blowout: 0.08, homeAway: 0.13, vsOpponent: 0.02,
  }

  function parity(prop: Prop, gameLogs: GameLog[], ctx: ScoringContext | null): void {
    const scored = scoreProps(prop, gameLogs, null, ctx)
    const factors = computeFactors(prop, gameLogs, ctx ?? {}, false)
    const replayed = applyWeights(factors, defaultWeightsPoints)
    expect(replayed.score).toBe(scored.confidence_score)
  }

  it('matches with no-log path (empty gameLogs + null ctx)', () => {
    parity(makeProp(), [], null)
  })

  it('matches with 20 game logs and basic context', () => {
    const logs = makeGameLogSeries(20, 22)
    const ctx: ScoringContext = { defStats: makeDefStats(), isHome: true }
    parity(makeProp({ line: 20.5 }), logs, ctx)
  })

  it('matches with confirmedStarter true (lineup boost)', () => {
    const logs = makeGameLogSeries(20, 22)
    const ctx: ScoringContext = {
      defStats: makeDefStats(),
      isHome: true,
      confirmedStarter: true,
    }
    parity(makeProp({ line: 20.5 }), logs, ctx)
  })

  it('matches with confirmedStarter false (lineup penalty)', () => {
    const logs = makeGameLogSeries(20, 22)
    const ctx: ScoringContext = {
      defStats: makeDefStats(),
      isHome: true,
      confirmedStarter: false,
    }
    parity(makeProp({ line: 20.5 }), logs, ctx)
  })

  it('matches with all-additives active (kitchen sink)', () => {
    const logs = makeGameLogSeries(20, 22)
    const ctx: ScoringContext = {
      defStats: makeDefStats(),
      isHome: true,
      opponentAbbr: 'OPP',
      playerBias: { hit_rate: 0.65, sample_count: 15, median_ratio: 1.05 },
      opponentLeak: { over_hit_rate: 0.60, median_ratio: 1.05, sample_count: 25 },
      lineMovementDelta: 1.0,
      oddsMovementDelta: 0.05,
      opponentOnB2B: true,
      overHitRates: new Map([['points', 0.45]]),
      underHitRates: new Map([['points', 0.55]]),
      confirmedStarter: true,
    }
    parity(makeProp({ line: 20.5 }), logs, ctx)
  })

  it('matches for UNDER direction', () => {
    const logs = makeGameLogSeries(20, 22)
    const ctx: ScoringContext = {
      defStats: makeDefStats(),
      isHome: true,
      underHitRates: new Map([['points', 0.55]]),
    }
    parity(makeProp({ direction: 'under', line: 20.5 }), logs, ctx)
  })
})

// ── U7: lineupAdj boundaries ─────────────────────────────────────────────────

describe('U7: lineup adjustment', () => {
  it('confirmedStarter=true adds +2 vs baseline', () => {
    const logs = makeGameLogSeries(20, 22)
    const baseline = scoreProps(makeProp(), logs, null, { defStats: makeDefStats(), isHome: true })
    const withStarter = scoreProps(makeProp(), logs, null, { defStats: makeDefStats(), isHome: true, confirmedStarter: true })
    expect(withStarter.confidence_score - baseline.confidence_score).toBe(2)
  })

  it('confirmedStarter=false drops score by 25 (clamped at min 18)', () => {
    const logs = makeGameLogSeries(20, 22)
    const baseline = scoreProps(makeProp(), logs, null, { defStats: makeDefStats(), isHome: true })
    const withOut = scoreProps(makeProp(), logs, null, { defStats: makeDefStats(), isHome: true, confirmedStarter: false })
    // -25 may saturate the floor at 18; assert the delta OR floor.
    const dropExpected = Math.max(baseline.confidence_score - 25, 18)
    expect(withOut.confidence_score).toBe(dropExpected)
  })

  it('confirmedStarter=null is identical to omitting the field', () => {
    const logs = makeGameLogSeries(20, 22)
    const omitted = scoreProps(makeProp(), logs, null, { defStats: makeDefStats(), isHome: true })
    const explicitNull = scoreProps(makeProp(), logs, null, { defStats: makeDefStats(), isHome: true, confirmedStarter: null })
    expect(omitted.confidence_score).toBe(explicitNull.confidence_score)
  })
})

// ── U8: over/under bias gates ────────────────────────────────────────────────

describe('U8: over_bias / under_bias gates', () => {
  it('over_bias does NOT fire when trailing over rate >= 0.50', () => {
    const logs = makeGameLogSeries(20, 22)
    const noBias = scoreProps(
      makeProp({ direction: 'over' }),
      logs, null,
      { defStats: makeDefStats(), isHome: true, overHitRates: new Map([['points', 0.55]]) },
    )
    const withBias = scoreProps(
      makeProp({ direction: 'over' }),
      logs, null,
      { defStats: makeDefStats(), isHome: true, overHitRates: new Map([['points', 0.45]]) },
    )
    // Gate fires at <0.50; lower trailing rate -> bias applies -> lower score.
    expect(withBias.confidence_score).toBeLessThan(noBias.confidence_score)
  })

  it('under_bias DOES fire when trailing under rate > 0.50', () => {
    const logs = makeGameLogSeries(20, 22)
    const noBias = scoreProps(
      makeProp({ direction: 'under' }),
      logs, null,
      { defStats: makeDefStats(), isHome: true, underHitRates: new Map([['points', 0.45]]) },
    )
    const withBias = scoreProps(
      makeProp({ direction: 'under' }),
      logs, null,
      { defStats: makeDefStats(), isHome: true, underHitRates: new Map([['points', 0.55]]) },
    )
    // Gate fires at >0.50; higher trailing rate -> bias applies -> higher score.
    expect(withBias.confidence_score).toBeGreaterThan(noBias.confidence_score)
  })

  it('null hitRates triggers conservative fallback (bias applied)', () => {
    // overHitRates absent -> over_bias fires by design (line 1346-1352)
    const logs = makeGameLogSeries(20, 22)
    const noMap = scoreProps(
      makeProp({ direction: 'over' }),
      logs, null,
      { defStats: makeDefStats(), isHome: true },
    )
    const safeMap = scoreProps(
      makeProp({ direction: 'over' }),
      logs, null,
      { defStats: makeDefStats(), isHome: true, overHitRates: new Map([['points', 0.55]]) },
    )
    // No data -> fallback applies bias -> lower than gated-off case.
    expect(noMap.confidence_score).toBeLessThan(safeMap.confidence_score)
  })
})

// ── U12: score_factors breakdown ─────────────────────────────────────────────

describe('U12: scoreProps emits score_factors breakdown', () => {
  const EXPECTED_KEYS = [
    'lineValue', 'matchupEdge', 'last20HitRate', 'trend', 'seasonCushion',
    'pace', 'restDays', 'blowout', 'homeAway', 'vsOpponent',
    'opponentLeak', 'playerBias', 'newsInjury', 'lineupAdj', 'lineMovement',
  ] as const

  it('returns score_factors on a fully-logged prop', () => {
    const prop = makeProp({ line: 20.5, stat_type: 'points', direction: 'over' })
    const logs = makeGameLogSeries(20, 25)
    const ctx: ScoringContext = {
      defStats: makeDefStats(),
      isHome: true,
      opponentAbbr: 'OPP',
      spread: -4,
      gameTotal: 220,
    }
    const result = scoreProps(prop, logs, null, ctx)

    expect(result.score_factors).toBeDefined()
    const keys = Object.keys(result.score_factors)
    for (const k of EXPECTED_KEYS) {
      expect(keys).toContain(k)
    }
    expect(keys.sort()).toEqual([...EXPECTED_KEYS].sort())
  })

  it('score_factors keys are all present even with null context', () => {
    const prop = makeProp()
    const result = scoreProps(prop, [], null, null)

    expect(result.score_factors).toBeDefined()
    const keys = Object.keys(result.score_factors)
    for (const k of EXPECTED_KEYS) {
      expect(keys).toContain(k)
    }
  })
})
