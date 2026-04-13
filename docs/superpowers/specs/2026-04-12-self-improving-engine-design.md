# Self-Improving Confidence Engine — Design Spec

**Date:** 2026-04-12
**Goal:** Automate weekly weight retraining, threshold recalibration, and over-bias adjustment so the confidence engine continuously improves from real outcome data without manual intervention.

## Background

The Prizm confidence engine (v11) uses per-stat weight sets, thresholds, and over-bias values that are manually tuned. The diagnostic pipeline + optimizer scripts already exist but run manually. This spec closes the feedback loop: a weekly GitHub Actions cron job retrains on recent `prop_grades`, validates improvements, and auto-deploys better weights.

## Architecture

Four components:

### 1. `lib/confidence-weights.json` — Runtime Weight Config

A JSON file that `confidence.ts` reads at runtime instead of hardcoded constants. Structure:

```json
{
  "version": "v11.1",
  "last_retrained": "2026-04-14T04:00:00Z",
  "data_window": { "start": "2026-02-13", "end": "2026-04-13", "game_days": 50, "graded_props": 35000 },
  "validation_accuracy": { "lock": 0.68, "play": 0.55, "overall": 0.52 },
  "previous_version": "v11.0",
  "weights": {
    "points": { "lineValue": 0.07, "matchupEdge": 0.02, ... },
    "rebounds": { ... },
    "assists": { ... },
    "pra": { ... },
    "blocks": { ... },
    "steals": { ... },
    "three_pointers": { ... }
  },
  "lock_thresholds": {
    "points": 74, "rebounds": 74, "assists": 78, "pra": 78,
    "steals": 78, "blocks": 78, "three_pointers": 76
  },
  "play_thresholds": {
    "points": 70, "rebounds": 72, "assists": 72, "pra": 76,
    "steals": 72, "blocks": 74, "three_pointers": 70
  },
  "base_lock_threshold": 74,
  "base_play_threshold": 68,
  "over_bias": {
    "points": -3, "rebounds": -4, "assists": -4,
    "steals": -7, "blocks": -6, "three_pointers": -3, "pra": -4
  },
  "previous_weights": {
    "weights": { ... },
    "lock_thresholds": { ... },
    "play_thresholds": { ... },
    "over_bias": { ... },
    "validation_accuracy": { "lock": 0.66, "play": 0.53 }
  }
}
```

### 2. `confidence.ts` Changes — Read Weights from JSON

Modify `getWeights()`, `getLabel()`, and the `overBiasAdj` section to read from `confidence-weights.json` at runtime. Keep current hardcoded v11 values as fallback defaults if the JSON file is missing, malformed, or has invalid data.

**Loading strategy:** Read and parse the JSON file once per enrichment batch (not per-prop). Cache in a module-level variable. The file is small (~2KB) so this is fast.

**Fallback behavior:** If `confidence-weights.json` doesn't exist or fails to parse:
- Log a warning: "confidence-weights.json not found, using hardcoded v11 defaults"
- Use the current hardcoded constants (W_POINTS, W_REBOUNDS, etc.)
- The engine continues to work identically to v11

### 3. `scripts/auto_retrain.py` — Weekly Retraining Script

**Input:** Rolling 60-day window from Supabase tables: `prop_grades`, `player_game_logs`, `team_defense_stats`

**Process:**

#### Step 0: Pre-flight Rollback Check
- Read current `confidence-weights.json`
- If `previous_weights` exists and `last_retrained` was 7+ days ago:
  - Pull last 7 days of `prop_grades`
  - Compute LOCK accuracy with current weights
  - If LOCK accuracy dropped >5pp below `validation_accuracy.lock`:
    - Swap `previous_weights` into `current` position
    - Log: "ROLLBACK: v{version} LOCK accuracy dropped {X}pp, reverting to {previous_version}"
    - Write updated JSON and exit (skip retraining this week)

#### Step 1: Load Data
- Fetch `prop_grades` for last 60 days (exclude DNPs where hit is null)
- Fetch `player_game_logs` (for factor recomputation)
- Fetch `team_defense_stats`

#### Step 2: Split Data (per stat type)
- Chronological split: first 75% = train, last 25% = validation
- No shuffling — preserves temporal ordering to prevent look-ahead bias

#### Step 3: Weight Optimization (on train set)
- For each stat type (points, rebounds, assists, steals, blocks, three_pointers, pra):
  - Recompute 8 factor scores for each graded prop (same factor functions as `backtest.py`)
  - Sample 10,000 weight vectors from Dirichlet distribution
  - For each weight vector: compute weighted confidence score per prop, apply current thresholds, measure LOCK + PLAY hit rates
  - Keep top 5 weight vectors ranked by: `0.6 * lock_hit_rate + 0.4 * play_hit_rate`

#### Step 4: Threshold Calibration (on train set)
- For the best weight vector per stat:
  - Scan LOCK thresholds: 70, 72, 74, 76, 78, 80, 82
  - For each LOCK threshold, scan PLAY thresholds: LOCK-4, LOCK-6, LOCK-8
  - Pick the (LOCK, PLAY) pair that maximizes LOCK accuracy while producing >= 3 LOCKs per week on average
- Also scan base thresholds: 70, 72, 74, 76

#### Step 5: Over-Bias Recalibration
- For each stat type, compute over vs. under hit rate from the full 60-day window
- New over bias = `round((under_rate - over_rate) * 30)` clamped to [-10, 0]
- This converts the percentage gap into a point adjustment (e.g., 19% gap for steals = -6 points)

#### Step 6: Validation
- Score all validation-set props with new weights + thresholds + over bias
- Compute LOCK accuracy, PLAY accuracy, overall accuracy
- Compare against current production weights scored on the same validation set

#### Step 7: Adoption Decision
- **Adopt if ALL of:**
  - New LOCK accuracy >= current LOCK accuracy (no regression)
  - Weighted score `(0.6 * LOCK + 0.4 * PLAY)` improves by >= 0.5 percentage points
  - At least 20 LOCK props in validation set
- **Reject if any condition fails.** Log reason and exit.

#### Step 8: Write Output
- If adopted: write `lib/confidence-weights.json` with:
  - New weights, thresholds, over bias as `current`
  - Old weights moved to `previous_weights`
  - Version incremented (v11.1, v11.2, etc.)
  - Metadata: retrained date, data window, validation accuracy
- If rejected: log "No improvement found" and exit without writing

**Dependencies:** Same as existing scripts — `requests`, `numpy`, `scikit-learn`, `scipy`

### 4. `.github/workflows/weekly-retrain.yml` — Cron Job

```yaml
schedule:
  - cron: '0 8 * * 1'  # Monday 8:00 UTC = 4:00 AM ET
```

Steps:
1. Checkout repo
2. Set up Python + install deps
3. Run `python scripts/auto_retrain.py`
4. If `confidence-weights.json` changed:
   - `git add lib/confidence-weights.json`
   - `git commit -m "chore(confidence): auto-retrain weights vX.Y"`
   - `git push origin master`
5. Vercel auto-deploys from master push

## Validation Strategy

The system validates itself:
- **Pre-deployment:** Validation set accuracy must beat current weights by >=0.5pp
- **Post-deployment:** Next week's pre-flight check measures real-world accuracy
- **Rollback:** If LOCK accuracy drops >5pp vs. validation prediction, auto-revert

## What This Does NOT Do

- Does NOT change the factor computation logic (the 8 factors remain the same)
- Does NOT add new factors or remove existing ones
- Does NOT change the additive adjustments (minutesTrend, minutesUncertainty, consensus, star bonus, etc.)
- Does NOT affect the frontend or any API routes other than enrichment
- Does NOT require any database schema changes

## Success Criteria

- Weekly retraining runs reliably on GitHub Actions
- Weights improve over time (measurable in diagnostic pipeline)
- Rollback triggers correctly when accuracy drops
- No manual intervention needed for normal operation
- Hardcoded fallback works if JSON is missing (zero downtime risk)
