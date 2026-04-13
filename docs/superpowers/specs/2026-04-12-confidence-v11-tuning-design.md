# Confidence Engine v11 — Data-Driven Tuning Spec

**Date:** 2026-04-12
**Goal:** Apply 5 targeted fixes to `lib/confidence.ts` based on diagnostic pipeline findings to improve LOCK/PLAY accuracy.

## Background

The v10 engine was diagnosed across 71,074 graded props (119 game days). Key issues:
- Three-pointer LOCKs hit 48.9% (target 65%)
- Assists/blocks LOCKs at 50-52.6%
- Overs underperform unders by 6% overall, 19% for steals
- `trend` factor is anti-correlated (AUC 0.490)
- `restDays` has no significant correlation (p=0.279)
- Model overconfident at 70+ scores (actual 15-20% below predicted)

## Deliverable

Update `lib/confidence.ts` from v10.0 to v11.0. Single file change, no new files.

## Fix 1: Raise LOCK/PLAY Thresholds for 3PM, Assists, Blocks

**File:** `lib/confidence.ts` — `LOCK_THRESHOLD_BY_STAT` and `PLAY_THRESHOLD_BY_STAT`

| Stat | LOCK (v10) | LOCK (v11) | PLAY (v10) | PLAY (v11) |
|------|-----------|-----------|-----------|-----------|
| three_pointers | 72 | **76** | 66 | **70** |
| assists | 74 | **78** | 68 | **72** |
| blocks | 74 | **78** | 72 | **74** |

All other stat thresholds unchanged.

## Fix 2: Stat-Specific Over Bias

**File:** `lib/confidence.ts` — replace flat `overBiasAdj = -3` with stat-specific map.

**Current:** `const overBiasAdj = direction === 'over' ? -3 : 0`

**New:** Stat-specific over bias based on diagnostic over/under gap data:

| Stat | Over Bias (pts) | Diagnostic gap |
|------|----------------|----------------|
| points | -3 | +3.3% |
| rebounds | -4 | +6.8% |
| assists | -4 | +7.0% |
| steals | -7 | +19.0% |
| blocks | -6 | +12.2% |
| three_pointers | -3 | +4.5% |
| pra | -4 | ~avg |

Implementation: a `OVER_BIAS_BY_STAT` constant map, lookup by `stat_type`.

## Fix 3: Reduce Trend Weight

**File:** `lib/confidence.ts` — all 7 stat-specific weight objects (W_POINTS through W_THREE_POINTERS).

`trend` factor is anti-correlated (AUC 0.490). Halve its weight in every stat set. Redistribute freed weight to `last20HitRate` (AUC 0.555, top factor).

| Weight Set | trend (v10) | trend (v11) | last20HitRate (v10) | last20HitRate (v11) |
|-----------|------------|------------|--------------------|--------------------|
| W_POINTS | 0.05 | 0.02 | 0.21 | 0.24 |
| W_REBOUNDS | 0.03 | 0.01 | 0.09 | 0.11 |
| W_ASSISTS | 0.04 | 0.02 | 0.07 | 0.09 |
| W_PRA | 0.06 | 0.03 | 0.05 | 0.08 |
| W_BLOCKS | 0.15 | 0.07 | 0.06 | 0.14 |
| W_STEALS | 0.04 | 0.02 | 0.12 | 0.14 |
| W_THREE_POINTERS | 0.06 | 0.03 | 0.09 | 0.12 |

All weight sets must still sum to 1.00.

## Fix 4: Drop restDays Weight

**File:** `lib/confidence.ts` — all 7 stat-specific weight objects.

`restDays` has no significant correlation (p=0.279). Set to 0.01 in all weight sets. Redistribute freed weight 50/50 to `last20HitRate` and `homeAway` (top 2 factors).

| Weight Set | restDays (v10) | restDays (v11) | Freed weight |
|-----------|---------------|---------------|-------------|
| W_POINTS | 0.12 | 0.01 | 0.11 → last20HitRate +0.06, homeAway +0.05 |
| W_REBOUNDS | 0.09 | 0.01 | 0.08 → last20HitRate +0.04, homeAway +0.04 |
| W_ASSISTS | 0.04 | 0.01 | 0.03 → last20HitRate +0.02, homeAway +0.01 |
| W_PRA | 0.03 | 0.01 | 0.02 → last20HitRate +0.01, homeAway +0.01 |
| W_BLOCKS | 0.08 | 0.01 | 0.07 → last20HitRate +0.04, homeAway +0.03 |
| W_STEALS | 0.07 | 0.01 | 0.06 → last20HitRate +0.03, homeAway +0.03 |
| W_THREE_POINTERS | 0.15 | 0.01 | 0.14 → last20HitRate +0.07, homeAway +0.07 |

## Fix 5: Raise Base LOCK/PLAY Thresholds

**File:** `lib/confidence.ts` — `getLabel()` function default thresholds.

Calibration curve shows 70-75 scores hit at 56.8% (should be 72.5%). Raise base thresholds:

| Threshold | v10 | v11 |
|----------|-----|-----|
| Base LOCK | 72 | **74** |
| Base PLAY | 66 | **68** |

The `LOCK_THRESHOLD_BY_STAT` and `PLAY_THRESHOLD_BY_STAT` overrides take precedence for stats that have them.

## Implementation Order for Weight Changes

Apply Fixes 3 and 4 together per weight set:
1. Read current v10 weight values
2. Halve `trend` (Fix 3)
3. Set `restDays` to 0.01 (Fix 4)
4. Compute total freed weight (old_trend/2 + old_restDays - 0.01)
5. Add 60% of freed weight to `last20HitRate`, 40% to `homeAway`
6. Verify sum = 1.00. If off by 0.01 due to rounding, adjust `last20HitRate`

Note: Some v10 weight sets may not sum to exactly 1.00 due to prior rounding. Normalize v11 sets to 1.00 regardless.

## Validation

After all changes:
1. Re-run `python scripts/model_diagnostic.py` to compare before/after
2. Key metrics to check:
   - LOCK accuracy should increase (fewer but better LOCKs)
   - Over/under gap should narrow for steals/blocks
   - `trend` anti-correlation warning should weaken or disappear
   - Calibration curve 70-85 gap should shrink
3. The diagnostic script reads from `prop_grades` (historical data with v10 scores), so it measures threshold impact but not weight changes. Weight changes would need a full backtest re-run to measure.

## Version Header

Update the header comment from v10.0 to v11.0 with a summary of changes.
