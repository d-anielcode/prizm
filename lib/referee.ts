/**
 * lib/referee.ts — Referee crew data and scoring adjustment.
 *
 * NBA referee assignments are publicly available ~24h before tip from the
 * league's officials page. Different ref crews call games at materially
 * different rates: foul rate per 48 min ranges ~38-52 across the active
 * crew pool. That variance directly affects free-throw volume (PTS / PRA
 * props) and pace (REB / 3PM via possessions).
 *
 * Public research suggests referee identity adds 0.02-0.04 AUC to player
 * prop models. Currently NOT in production. This module is scaffolding so
 * we can begin ingesting in the off-season and wire the factor when we
 * have ≥1 month of (game, ref-crew, outcome) data to fit weights against.
 *
 * ## Schema (run once when ready)
 *
 *   create table referee_assignments (
 *     game_id      text primary key,
 *     game_date    date not null,
 *     ref1_name    text,
 *     ref2_name    text,
 *     ref3_name    text,
 *     fetched_at   timestamptz not null default now()
 *   );
 *   create index idx_ref_assign_date on referee_assignments (game_date);
 *
 *   create table referee_stats (
 *     ref_name              text primary key,
 *     games_called          integer not null default 0,
 *     fouls_per_game        numeric(5,2),
 *     fts_per_game          numeric(5,2),
 *     pace_per_game         numeric(5,2),
 *     last_calculated_at    timestamptz not null default now()
 *   );
 *
 * ## Data sources
 *
 *  1. https://official.nba.com/referee-assignments/  (primary — ~24h pre-tip)
 *  2. https://www.basketball-reference.com/leagues/NBA_<year>_referees.html
 *     (per-ref stats; rebuilt weekly)
 *  3. https://www.basketball-reference.com/boxscores/<game_id>.html
 *     (after-the-fact confirmation; "Officials: ..." section at bottom)
 *
 * ## Wiring (when ready)
 *
 *   1. Cron `/api/refs/fetch?date=YYYY-MM-DD` 30 min after assignments post (~5pm ET)
 *   2. Cron `/api/refs/stats?action=recompute` weekly (Sunday) to refresh
 *      per-ref foul/FT/pace averages from the prior 30 days
 *   3. Enrich loads `referee_assignments` joined to `referee_stats` and
 *      passes a `refereeContext` into ScoringContext
 *   4. lib/confidence.ts adds `refereeAdj` to the scoring formula:
 *
 *        refereeAdj = stat_specific_sensitivity(stat_type) *
 *                     (ref_crew_avg - league_avg) *
 *                     (direction === 'over' ? 1 : -1)
 *
 *      Capped at ±3 pts. PTS/PRA most sensitive (~1.5x), 3PM mildly,
 *      REB/AST/STL/BLK basically unaffected.
 */

export interface RefereeAssignment {
  game_id:    string
  game_date:  string  // YYYY-MM-DD (Eastern)
  refs:       string[]  // typically 3 names
}

export interface RefereeStats {
  ref_name:       string
  games_called:   number
  fouls_per_game: number | null
  fts_per_game:   number | null
  pace_per_game:  number | null
}

export interface RefereeContext {
  /** Crew-average vs league-average for fouls called. Positive = whistle-happy
   *  crew (boosts FT volume → favors PTS / PRA overs). */
  fouls_delta: number
  /** Crew-average vs league-average for pace. Positive = faster game (more
   *  possessions → favors all volume-stat overs). */
  pace_delta:  number
  /** Number of refs with stats available, for confidence weighting. */
  refs_sampled: number
}

/**
 * Compute the referee adjustment for a given prop. Returns 0 when data is
 * missing — fail-safe.
 *
 * NOT WIRED INTO PRODUCTION SCORING YET. This is the planned interface; when
 * /api/refs/fetch is shipping data and we have ≥1 month of (game, ref, outcome)
 * tuples, switch the production scoreProps() to call this and weight the
 * result. Until then it's pure documentation of the intended shape.
 */
export function refereeAdjustment(
  ctx:       RefereeContext | null,
  statType:  string,
  direction: 'over' | 'under',
): number {
  if (!ctx || ctx.refs_sampled === 0) return 0

  // Stat sensitivity to referee crew: PTS / PRA most affected via free throws,
  // 3PM mildly via fouls-on-shooter, REB / AST / STL / BLK ~unaffected.
  const sensitivity: Record<string, number> = {
    points:         1.5,
    pra:            1.2,
    three_pointers: 0.6,
    rebounds:       0.2,
    assists:        0.2,
    blocks:         0.1,
    steals:         0.1,
  }
  const s = sensitivity[statType] ?? 0.0

  // Combined delta: FT-driven via fouls + pace-driven via possessions.
  // Magnitudes calibrated empirically once we have data; this is a starting
  // point that scales the linear estimate to ±3 pt cap.
  const raw = ctx.fouls_delta * 0.5 + ctx.pace_delta * 0.3
  const sided = direction === 'over' ? raw : -raw
  const adj = sided * s

  return Math.max(-3, Math.min(3, adj))
}
