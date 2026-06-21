# Per-Stat Confidence Model Refactor

**Date:** 2026-05-26
**Status:** Design — pending implementation plan

## Problem

The confidence score function no longer separates winners from losers for high-volume stats. 30-day prop_grades counterfactual:

| Stat | Score → hit-rate behavior |
|------|---------------------------|
| points | flat — no threshold reaches ≥66% hit (n=1768 below 60, 49.4% hit) |
| three_pointers | flat — no threshold reaches ≥66% hit |
| rebounds | works-ish — 70-72 band hits 80%, 64-66 band hits 68% |
| assists | works-ish — 68-70 band hits 67% |
| steals | works — 72-74 band hits 88% |
| blocks | works — 68-70 band hits 92% |
| pra | mixed — top bands work but middle bands inverted |

Tier label outcomes confirm the score problem: current LOCK tier hits 50.0% on n=18 over 30 days — worse than PLAY (61.6%). Threshold tuning is cosmetic; the underlying score signal needs work.

## Scope

Refactor the confidence model **per stat**. Each market (points, rebounds, assists, three_pointers, pra, blocks, steals) gets its own pass:
- factor audit (which existing factors carry real signal)
- factor pruning (drop dead/inverted weights)
- new factor exploration (candidate signals not yet in the model)
- regression-derived weights replacing hand-tuned values
- acceptance gate before shipping per stat

**Out of scope:**
- Tier label/threshold tuning (downstream — fixes itself once scores separate)
- Non-interpretable ML (no XGBoost / neural nets — we need to debug factor by factor)
- Live retraining loop changes (auto_retrain.py unchanged)
- The lineupAdj / newsInjury / lineMovement factors initially (point-in-time data not preserved — these enter Phase B once instrumented)

## Architecture

### Component 1: Feature reconstruction pipeline

**`scripts/confidence_features.py`** — Python port of the reconstructable factors from `lib/confidence.ts`. One function per factor, signature `f(player_logs, prop, opponent_logs, ...) -> float`. Must produce bit-identical output to the TS version (validated by a fixtures test).

**`scripts/build_feature_table.py`** — for each row in `prop_grades` with `hit != null`:
- Load player game logs filtered to `game_date < prop.game_date` (no leakage)
- Load historical_prop_lines available as of game_date
- Recompute each reconstructable factor via `confidence_features.py`
- Upsert one row into new `prop_features` table

Schema for `prop_features`:
```
id (FK to prop_grades.id)
stat_type, line, direction, hit         -- denormalized for query simplicity
line_value, matchup_edge, last20_hit_rate, trend, season_cushion,
pace, rest_days, blowout, home_away, vs_opponent,
opponent_leak, player_bias              -- one numeric column per factor
feature_version                         -- bump when feature code changes
computed_at
```

One-time backfill: ~9k rows. Incremental nightly cron after.

### Component 2: Score-time instrumentation

Modify `lib/confidence.ts` to also write the factor contributions into a new `score_factors` JSONB column on `props`. This eliminates reconstruction for future props and locks in point-in-time correctness for the hard factors (newsInjury, lineupAdj, lineMovement).

After a sufficient sample accumulates (~2 weeks at current volume = ~5k props), Phase B regression can include these factors.

### Component 3: Factor audit tool

**`scripts/factor_audit.py <stat>`** — given a stat name, joins `prop_features` with `prop_grades`, then runs:

1. **Univariate analysis** — for each factor, bucket props by factor value (quintiles), plot hit rate. Output: which factors show monotonic separation vs flat.
2. **Logistic regression** — `hit ~ all factors` for the stat. Output: coefficients + standard errors + p-values per factor.
3. **Recommended weights** — normalize abs(coefficient) for factors with p < 0.10 to sum to 1.0. Output the JSON block ready to paste into `confidence-weights.json`.

### Component 4: Per-stat refactor loop

For each of 7 stats, starting with rebounds (works-ish, validates pipeline):

1. Run factor_audit
2. Drop factors with p > 0.10 or wrong-sign coefficients
3. Brainstorm and prototype 1-3 candidate new factors (per-stat — see below)
4. Re-regress with new factors included
5. Lock in final weights
6. Counterfactual on the most recent 7 days held out: refactored vs current
7. **Acceptance gate:** refactored model must show ≥3 score buckets with monotonically increasing hit rate AND ≥5pp lift in top-bucket hit rate vs current. If gate fails, stat moves to a "needs new signal" backlog rather than shipping noise.
8. Ship as its own PR/commit; move to next stat

### Component 5: Candidate new factors

Initial brainstorm pool (each stat selects from these + invents its own):

- **back_to_back** — did the player play a game in the last 24h
- **minutes_trend_3g** — last 3 games average minutes vs season average (workload signal)
- **vegas_proj_delta** — our last20 average vs the prop line, normalized by line magnitude
- **opp_pace_position** — opponent pace × player position (interaction)
- **same_opp_recent** — performance vs this specific opponent in last 30 days (smaller, faster signal than season-long vsOpponent)
- **role_classifier** — primary/secondary/role-player tag derived from season minutes
- **rest_age_interaction** — days_rest × age bracket (older players punished more by short rest)
- **home_road_by_stat** — current homeAway is one weight per stat; consider direction-of-effect (some players + on road for assists, − for points)
- **line_round_number** — whether line is a whole vs half number (book sharpness signal)
- **back_to_back_b2b_for_opp** — opponent's rest situation too

Each new factor needs:
- Reconstruction function in `confidence_features.py`
- Unit test with at least 3 hand-computed fixtures
- Inclusion in the next factor_audit run

## Data flow

```
prop_grades (existing) ──┐
                         ├──► scripts/build_feature_table.py ──► prop_features (new)
player_game_logs ────────┤                                              │
historical_prop_lines ───┘                                              │
                                                                        ▼
                                                              scripts/factor_audit.py
                                                                        │
                                                                        ▼
                                                              recommended weights
                                                                        │
                                                                        ▼
                                                  manually edit lib/confidence-weights.json
                                                                        │
                                                                        ▼
                                                          counterfactual on held-out 7d
                                                                        │
                                                                        ▼
                                                                      ship
```

Score-time instrumentation runs in parallel:

```
lib/confidence.ts computeAdditives → props.score_factors (new JSONB column)
                                              │
                                              └──► future Phase B regression
                                                   includes newsInjury,
                                                   lineupAdj, lineMovement
```

## Error handling

- **Feature reconstruction mismatch with TS scorer** — fixtures test must pass before backfill runs. Discrepancies require either bug-fixing the Python port or accepting a known-divergence and documenting it.
- **Missing game logs for historical props** — props where required logs aren't available are skipped, not zero-filled. Log counts in build_feature_table output so we can detect coverage gaps.
- **Regression instability** — if a stat has < 200 graded samples, refuse to fit and report "insufficient data, instrument and wait."
- **Acceptance gate failure** — stat moves to backlog, does not ship. No silent "best-effort" rollouts.

## Testing

- **Per-factor unit tests** — `tests/confidence_features_test.py` with hand-computed fixtures. At least 3 cases per factor (typical, edge, missing-data).
- **Pipeline integration test** — given a known seed prop_grades row, build_feature_table produces expected prop_features row.
- **TS↔Python parity test** — for a sample of 50 recent props, recomputed Python features must match `props.score_factors` (once instrumentation lands) within float epsilon.
- **Counterfactual harness** — `scripts/counterfactual.py <stat> <held_out_days>` runs both current and proposed weights over a held-out window and reports hit-rate-at-volume curves side by side.

## Phase sequencing

**Phase A (this spec):**
1. Build confidence_features.py + parity tests
2. Build build_feature_table.py + run one-time backfill
3. Build factor_audit.py
4. Add score_factors instrumentation to confidence.ts (start collecting going forward)
5. Refactor rebounds (validates pipeline)
6. Refactor remaining 6 stats one at a time

**Phase B (future, after 2-4 weeks of instrumentation):**
- Include newsInjury, lineupAdj, lineMovement in regressions
- Re-tune any stat where Phase A skipped signal due to missing point-in-time data

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Python features don't match TS exactly | High | Fixtures parity test, fail loudly on first divergence |
| 9k samples too small for 12-factor regression on rare stats | Medium | Per-stat minimum sample check; merge low-volume stats with similar profiles only if necessary |
| New factors don't actually help | Medium | Acceptance gate forces real improvement; "needs new signal" backlog is acceptable outcome |
| Backfill includes leakage somewhere | Medium | All log queries strictly `game_date < prop.game_date`; spot-check 10 random props by hand |
| Refactoring a working stat (steals, blocks) makes it worse | Low | Acceptance gate is a strict improvement requirement; if proposed model isn't strictly better, don't ship |

## Success criteria

- ≥5 of 7 stats clear the acceptance gate and ship refactored
- For stats that ship: top score-band hit rate ≥65% with ≥3 props/day landing in that band
- Backlog stats have clear documentation of "what signal we'd need" rather than vague "model broken"
