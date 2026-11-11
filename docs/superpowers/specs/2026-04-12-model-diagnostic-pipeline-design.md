# Model Diagnostic Pipeline — Design Spec

**Date:** 2026-04-12
**Goal:** Build an error analysis pipeline that identifies where the v10 confidence model fails, so accuracy improvements can be targeted rather than guessed.

## Background

The Prizm confidence engine v10 achieves 66.4% LOCK accuracy and 52.8% PLAY accuracy across 75 game days (Dec 26 – Mar 19). These numbers are aggregate — we don't know which stat types, factors, or game contexts are dragging accuracy down vs. carrying it. Before tuning weights or adding signals, we need a diagnostic map.

## Deliverable

A new Python script `scripts/model_diagnostic.py` that queries Supabase, runs 7 analysis modules, and outputs:
- `diagnostic_report.json` — structured results for all analyses
- Terminal summary — human-readable findings printed to stdout

## Data Sources (all from Supabase)

| Table | Purpose |
|-------|---------|
| `prop_grades` | Graded props: confidence score, label, hit/miss, stat type, direction |
| `player_game_logs` | Box scores for computing factor values and actual outcomes |
| `team_defense_stats` | Defensive ranks at time of game |
| `historical_prop_lines` | Line values + movement for sharp money analysis |
| `prop_history` | Daily prop snapshots for tracking line changes |
| `player_line_bias` | Historical over/under bias per player |

## Analysis Modules

### 1. `accuracy_matrix()`
Cross-tabulate hit rate by **stat type** (points, rebounds, assists, steals, blocks, 3PM) x **confidence tier** (LOCK, PLAY, LEAN, FADE).

Output: 6x4 matrix of hit rates + sample sizes. The primary diagnostic table.

### 2. `factor_calibration()`
For each of the 11 weighted factors (lineValue, matchupEdge, last20HitRate, trend, seasonCushion, pace, newsInjury, restDays, blowout, homeAway, vsOpponent):
- Point-biserial correlation with outcome (hit/miss)
- Per-factor AUC (how well does this factor alone predict outcomes?)
- Direction check: are any factors anti-correlated?

Output: ranked list of factors by predictive power.

### 3. `over_under_asymmetry()`
Hit rate by direction (over/under) x stat type. The model applies a flat -3pt over bias. This checks if:
- The bias is the right magnitude
- It should be stat-specific (e.g., over on rebounds vs. over on 3PM)

Output: over/under hit rate table by stat type.

### 4. `calibration_curve()`
Bucket props by confidence score (5-point buckets: 40-45, 45-50, ..., 80-85) and compute actual hit rate per bucket.

A well-calibrated model has hit rate ≈ confidence score / 100. Overconfident models show hit rate < score in high buckets.

Output: array of {bucket, predicted_rate, actual_rate, n} objects.

### 5. `high_confidence_misses()`
Filter to LOCK + PLAY misses. For each miss, capture:
- Stat type, direction, line, player, opponent
- Individual factor scores (all 11)
- Additive adjustments applied

Then cluster to find common patterns (e.g., "most LOCK misses on steals had low matchupEdge but high hitRate").

Output: list of miss profiles + top recurring patterns.

### 6. `line_movement_analysis()`
Using `historical_prop_lines` and `prop_history`:
- Correlation between line movement direction and outcome
- Validate the `lineMovAdj` and `oddsMovAdj` signals — are they actually predictive?
- Sharp money signal: when lines move against the model's pick direction, does accuracy drop?

Output: line move impact table with accuracy deltas.

### 7. `temporal_analysis()`
Accuracy by calendar month and by week number. Checks for:
- Early-season noise (small sample game logs in Oct/Nov)
- Late-season load management impact (Mar/Apr)
- All-Star break / trade deadline disruption
- General drift: is the model getting better or worse over time?

Output: time series of weekly/monthly accuracy.

## Dependencies

Same as existing backtest scripts — no new packages required:
- `requests` (Supabase queries)
- `numpy` (statistics)
- `scikit-learn` (AUC, correlations)

## Output Format

```json
{
  "generated_at": "2026-04-12T...",
  "data_range": { "start": "2025-12-26", "end": "2026-03-19", "game_days": 75 },
  "accuracy_matrix": { ... },
  "factor_calibration": { ... },
  "over_under_asymmetry": { ... },
  "calibration_curve": [ ... ],
  "high_confidence_misses": { "count": N, "patterns": [ ... ] },
  "line_movement": { ... },
  "temporal": { ... }
}
```

## Usage

```bash
python scripts/model_diagnostic.py
python scripts/model_diagnostic.py --stat points    # single stat deep dive
python scripts/model_diagnostic.py --start-date 2026-01-01  # date range filter
```

## What Comes Next

The diagnostic report will produce a ranked list of accuracy issues. The top 2-3 issues become targeted fixes to the confidence engine (weight adjustments, new additive adjustments, or threshold changes). Each fix gets backtested before deployment.
