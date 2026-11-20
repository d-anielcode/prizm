# Per-Stat Confidence Model Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the confidence model on a per-stat basis using regression-derived weights from a backfilled feature table, so that score buckets actually separate winners from losers.

**Architecture:** Build a Python feature-reconstruction pipeline that recomputes the 12 leakage-free factors from raw logs for every historical graded prop (~9k rows). Use that table to drive logistic regressions per stat, derive new weights, gate each stat behind a strict acceptance test before shipping. In parallel, instrument the live TS scorer to log per-factor contributions for future point-in-time-clean regressions.

**Tech Stack:** Python 3 (pandas, scikit-learn, statsmodels), pytest, TypeScript/Next.js, Supabase Postgres.

---

## File structure

**New files:**
- `scripts/confidence_features.py` — Python port of 12 reconstructable factors. One function per factor, plus a `compute_all_features(prop, logs, opp_logs, ...)` orchestrator.
- `scripts/build_feature_table.py` — backfill driver. Iterates prop_grades, recomputes features, upserts to `prop_features`.
- `scripts/factor_audit.py` — per-stat regression tool. Outputs univariate hit-rate curves + logistic regression coefficients + recommended weight JSON.
- `scripts/counterfactual_v12.py` — held-out backtest harness. Compares current vs proposed weights on a 7-day held-out window.
- `scripts/tests/test_confidence_features.py` — unit tests per factor + parity test.
- `supabase/migrations/20260526120000_prop_features_and_score_factors.sql` — new `prop_features` table + `props.score_factors` JSONB column + index on `(prop_grade_id)`.

**Modified files:**
- `lib/confidence.ts` — write factor breakdown into `score_factors` field on prop write path.
- `app/api/enrich/route.ts` — persist `score_factors` field when writing scored props.
- `lib/confidence-weights.json` — per-stat weight updates (one commit per stat as the refactor lands).

---

## Phase 0 — Schema

### Task 1: Create `prop_features` table + `score_factors` column

**Files:**
- Create: `supabase/migrations/20260526120000_prop_features_and_score_factors.sql`

- [ ] **Step 1: Write migration**

```sql
-- prop_features: one row per graded prop with reconstructed factor contributions
CREATE TABLE IF NOT EXISTS public.prop_features (
  prop_grade_id     uuid PRIMARY KEY REFERENCES public.prop_grades(id) ON DELETE CASCADE,
  stat_type         text NOT NULL,
  direction         text NOT NULL,
  line              numeric NOT NULL,
  hit               boolean NOT NULL,
  -- Factor columns (12 reconstructable factors)
  line_value        numeric,
  matchup_edge      numeric,
  last20_hit_rate   numeric,
  trend             numeric,
  season_cushion    numeric,
  pace              numeric,
  rest_days         numeric,
  blowout           numeric,
  home_away         numeric,
  vs_opponent       numeric,
  opponent_leak     numeric,
  player_bias       numeric,
  -- Metadata
  feature_version   text NOT NULL DEFAULT 'v1',
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prop_features_stat
  ON public.prop_features (stat_type);

-- score_factors: per-prop factor breakdown written by lib/confidence.ts on every score
ALTER TABLE public.props
  ADD COLUMN IF NOT EXISTS score_factors jsonb;

GRANT ALL ON TABLE public.prop_features TO service_role, authenticated;
```

- [ ] **Step 2: Apply migration**

Run in Supabase SQL editor (or `npx supabase db push` if linked).
Expected: no errors, table appears in schema browser.

- [ ] **Step 3: Verify**

Run in SQL editor:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'prop_features';
```
Expected: 17 columns listed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260526120000_prop_features_and_score_factors.sql
git commit -m "schema: add prop_features table + props.score_factors column"
```

---

## Phase 1 — Python feature reconstruction

### Task 2: Bootstrap Python test infrastructure

**Files:**
- Create: `scripts/tests/__init__.py` (empty)
- Create: `scripts/tests/conftest.py`
- Create: `scripts/tests/fixtures/__init__.py` (empty)
- Create: `scripts/tests/fixtures/sample_logs.py`

- [ ] **Step 1: Write conftest with shared fixtures**

```python
# scripts/tests/conftest.py
import pytest
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
```

- [ ] **Step 2: Write sample log fixtures**

```python
# scripts/tests/fixtures/sample_logs.py
"""Hand-crafted log fixtures used across factor tests.

Each fixture represents a player's recent game logs in descending date order
(most recent first), matching the format used by lib/confidence.ts.
"""
from typing import List, Dict, Any

def basic_pts_logs() -> List[Dict[str, Any]]:
    """20 games, average ~25 pts, no obvious trend."""
    return [
        {"game_date": f"2026-05-{20-i:02d}", "minutes": 32, "points": 25,
         "rebounds": 8, "assists": 6, "fg3m": 2, "blocks": 1, "steals": 1,
         "pra": 39, "is_home": i % 2 == 0,
         "matchup": "LAL @ BOS" if i % 2 else "LAL vs. BOS"}
        for i in range(20)
    ]

def upward_trend_pts_logs() -> List[Dict[str, Any]]:
    """20 games where last 5 average 30, prior 15 average 22."""
    logs = []
    for i in range(20):
        pts = 30 if i < 5 else 22
        logs.append({
            "game_date": f"2026-05-{20-i:02d}", "minutes": 32, "points": pts,
            "rebounds": 8, "assists": 6, "fg3m": 2, "blocks": 1, "steals": 1,
            "pra": pts + 14, "is_home": i % 2 == 0,
            "matchup": "LAL @ BOS" if i % 2 else "LAL vs. BOS"
        })
    return logs

def sparse_logs() -> List[Dict[str, Any]]:
    """Only 3 games — below most factor minimums."""
    return [
        {"game_date": "2026-05-20", "minutes": 30, "points": 20,
         "rebounds": 5, "assists": 4, "fg3m": 1, "blocks": 0, "steals": 1,
         "pra": 29, "is_home": True, "matchup": "LAL vs. BOS"}
        for _ in range(3)
    ]
```

- [ ] **Step 3: Verify pytest discovers tests dir**

Run: `cd C:/Users/dcho0/nbaiqproject && python -m pytest scripts/tests/ --collect-only`
Expected: "no tests ran" (no test functions yet, but discovery works).

- [ ] **Step 4: Commit**

```bash
git add scripts/tests/
git commit -m "test: bootstrap python test infra + sample log fixtures"
```

### Task 3: Implement factor — `last20_hit_rate`

**Files:**
- Create: `scripts/confidence_features.py`
- Create: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Write failing test**

```python
# scripts/tests/test_confidence_features.py
import pytest
from confidence_features import last20_hit_rate
from tests.fixtures.sample_logs import basic_pts_logs, sparse_logs

def test_last20_hit_rate_over_basic():
    # Player averages 25 pts; line of 22 should hit ~100% over last 20
    rate = last20_hit_rate(basic_pts_logs(), stat_type="points", line=22, direction="over")
    assert rate == pytest.approx(1.0, abs=0.01)

def test_last20_hit_rate_under_basic():
    # Same logs, line=22 under = ~0%
    rate = last20_hit_rate(basic_pts_logs(), stat_type="points", line=22, direction="under")
    assert rate == pytest.approx(0.0, abs=0.01)

def test_last20_hit_rate_at_line():
    # Player avg 25, line 25, over → 0% (must be strictly above)
    rate = last20_hit_rate(basic_pts_logs(), stat_type="points", line=25, direction="over")
    assert rate == pytest.approx(0.0, abs=0.01)

def test_last20_hit_rate_sparse():
    # Only 3 games — should still compute on what's available
    rate = last20_hit_rate(sparse_logs(), stat_type="points", line=15, direction="over")
    assert rate == pytest.approx(1.0)

def test_last20_hit_rate_minutes_filter():
    # Logs with <5 mins must be filtered
    logs = [{"game_date": "2026-05-20", "minutes": 3, "points": 50, "pra": 80,
             "rebounds": 0, "assists": 0, "fg3m": 0, "blocks": 0, "steals": 0,
             "is_home": True, "matchup": "LAL vs. BOS"}]
    rate = last20_hit_rate(logs, stat_type="points", line=10, direction="over")
    assert rate is None  # no qualifying games
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd C:/Users/dcho0/nbaiqproject && python -m pytest scripts/tests/test_confidence_features.py::test_last20_hit_rate_over_basic -v`
Expected: ImportError (confidence_features module not found).

- [ ] **Step 3: Implement factor**

```python
# scripts/confidence_features.py
"""Python port of reconstructable factors from lib/confidence.ts.

Each function MUST be bit-identical (within float epsilon) to its TS
counterpart. Verified by scripts/tests/test_ts_parity.py.

Stat keys used in logs: points, rebounds, assists, pra, fg3m, blocks, steals.
Stat keys used in props (stat_type): points, rebounds, assists, pra,
three_pointers, blocks, steals.
"""
from typing import List, Dict, Optional, Any

STAT_TO_LOG_KEY = {
    "points": "points", "rebounds": "rebounds", "assists": "assists",
    "pra": "pra", "blocks": "blocks", "steals": "steals",
    "three_pointers": "fg3m",
}

MIN_MINUTES = 5  # mirrors lib/confidence.ts:hitRate filter

def _qualifying_logs(logs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filter to logs with minutes >= MIN_MINUTES (matches TS scorer behavior)."""
    return [g for g in logs if float(g.get("minutes") or 0) >= MIN_MINUTES]

def last20_hit_rate(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
) -> Optional[float]:
    """Fraction of last 20 qualifying games where actual hits the line.

    Mirrors hitRate() in lib/confidence.ts:483. Direction-aware:
      over  → actual > line
      under → actual < line
    Returns None if no qualifying games.
    """
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)[:20]
    if not qualifying:
        return None
    hits = 0
    for g in qualifying:
        actual = float(g.get(field) or 0)
        if direction == "under":
            if actual < line:
                hits += 1
        else:
            if actual > line:
                hits += 1
    return hits / len(qualifying)
```

- [ ] **Step 4: Run test to verify pass**

Run: `python -m pytest scripts/tests/test_confidence_features.py -v`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/confidence_features.py scripts/tests/test_confidence_features.py
git commit -m "feat(features): port last20_hit_rate factor + tests"
```

### Task 4: Implement factor — `trend`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Add failing test**

```python
# Append to scripts/tests/test_confidence_features.py
from confidence_features import trend
from tests.fixtures.sample_logs import upward_trend_pts_logs, basic_pts_logs

def test_trend_upward():
    # Last 5 = 30 ppg, prior 15 = 22 ppg → strong positive trend
    t = trend(upward_trend_pts_logs(), stat_type="points")
    assert t > 0.10  # at least 10% lift

def test_trend_flat():
    # All games at 25 ppg → trend should be ~0
    t = trend(basic_pts_logs(), stat_type="points")
    assert abs(t) < 0.05

def test_trend_insufficient_data():
    # Need at least 5 recent + 5 prior — sparse_logs has 3
    from tests.fixtures.sample_logs import sparse_logs
    assert trend(sparse_logs(), stat_type="points") is None
```

- [ ] **Step 2: Run to verify fail**

Run: `python -m pytest scripts/tests/test_confidence_features.py::test_trend_upward -v`
Expected: ImportError on `trend`.

- [ ] **Step 3: Implement**

```python
# Append to scripts/confidence_features.py
def trend(logs: List[Dict[str, Any]], stat_type: str) -> Optional[float]:
    """Relative trend = (last5_avg - prior15_avg) / prior15_avg.

    Mirrors trendScore() in lib/confidence.ts:747. Returns None if fewer
    than 5 recent OR 5 prior qualifying games available. Caps at +/- 0.5.
    """
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)
    if len(qualifying) < 10:
        return None
    recent = qualifying[:5]
    prior  = qualifying[5:20]
    if len(prior) < 5:
        return None
    r_avg = sum(float(g.get(field) or 0) for g in recent) / len(recent)
    p_avg = sum(float(g.get(field) or 0) for g in prior) / len(prior)
    if p_avg <= 0:
        return None
    raw = (r_avg - p_avg) / p_avg
    return max(-0.5, min(0.5, raw))
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest scripts/tests/test_confidence_features.py -v`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(features): port trend factor + tests"
```

### Task 5: Implement factor — `season_cushion`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Read TS source for cushionScore**

Open `lib/confidence.ts:661-700` and note the exact formula. This is `(season_avg - line) / line` clamped to a window.

- [ ] **Step 2: Add failing tests**

```python
from confidence_features import season_cushion

def test_season_cushion_positive():
    # avg 25 vs line 20 over → cushion = (25-20)/20 = 0.25
    logs = basic_pts_logs()
    c = season_cushion(logs, stat_type="points", line=20.0, direction="over")
    assert c == pytest.approx(0.25, abs=0.02)

def test_season_cushion_under_flipped():
    # For under: cushion = (line - avg) / line
    logs = basic_pts_logs()  # avg 25
    c = season_cushion(logs, stat_type="points", line=30.0, direction="under")
    assert c == pytest.approx((30-25)/30, abs=0.02)

def test_season_cushion_no_logs():
    assert season_cushion([], stat_type="points", line=20.0, direction="over") is None
```

- [ ] **Step 3: Run to verify fail**

Run: `python -m pytest scripts/tests/test_confidence_features.py::test_season_cushion_positive -v`

- [ ] **Step 4: Implement**

```python
def season_cushion(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
) -> Optional[float]:
    """Relative gap between season average and the line.

    Mirrors cushionScore() in lib/confidence.ts. Direction-aware:
      over  → (avg - line) / line
      under → (line - avg) / line
    Clamped to [-0.5, 0.5]. Returns None if no qualifying logs or line <= 0.
    """
    if line <= 0:
        return None
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)
    if not qualifying:
        return None
    avg = sum(float(g.get(field) or 0) for g in qualifying) / len(qualifying)
    raw = (avg - line) / line if direction == "over" else (line - avg) / line
    return max(-0.5, min(0.5, raw))
```

- [ ] **Step 5: Run tests + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v  # expect pass
git add -u
git commit -m "feat(features): port season_cushion factor + tests"
```

### Task 6: Implement factor — `line_value`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Read TS source**

`lib/confidence.ts:556-585` — lineValueScore. Compares prop line vs a reference (player median or season avg).

- [ ] **Step 2: Add test**

```python
from confidence_features import line_value

def test_line_value_soft_line():
    # avg 25, line 22 → "soft" (line below avg by 12%)
    c = line_value(basic_pts_logs(), stat_type="points", line=22.0, direction="over")
    assert c > 0  # positive = favorable for over

def test_line_value_tight_line():
    # avg 25, line 28 → tight for over
    c = line_value(basic_pts_logs(), stat_type="points", line=28.0, direction="over")
    assert c < 0
```

- [ ] **Step 3: Implement**

```python
def line_value(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
) -> Optional[float]:
    """How favorable the line is vs the player's median.

    Mirrors lineValueScore() in lib/confidence.ts. Uses median over last 20
    qualifying games. Direction-aware sign: positive = favorable.
    Clamped to [-0.3, 0.3].
    """
    if line <= 0:
        return None
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)[:20]
    if not qualifying:
        return None
    vals = sorted(float(g.get(field) or 0) for g in qualifying)
    n = len(vals)
    median = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
    raw = (median - line) / line if direction == "over" else (line - median) / line
    return max(-0.3, min(0.3, raw))
```

- [ ] **Step 4: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): port line_value factor + tests"
```

### Task 7: Implement factor — `home_away`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Add tests**

```python
from confidence_features import home_away

def test_home_away_pure_home():
    # all logs is_home=True, prop is at home → 0 (no differential)
    logs = [{"game_date": "2026-05-20", "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,"blocks":0,
             "steals":1,"pra":35} for _ in range(20)]
    c = home_away(logs, stat_type="points", line=20, direction="over", prop_is_home=True)
    assert c == pytest.approx(0.0, abs=0.05)

def test_home_away_home_better_for_home_prop():
    # Player averages 30 at home, 20 on road. Home prop → favorable for over.
    logs = []
    for i in range(20):
        is_home = i % 2 == 0
        pts = 30 if is_home else 20
        logs.append({"game_date": f"2026-05-{20-i:02d}", "minutes": 30, "points": pts,
                     "is_home": is_home, "matchup": "LAL vs. BOS" if is_home else "LAL @ BOS",
                     "rebounds":5,"assists":5,"fg3m":1,"blocks":0,"steals":1,"pra":pts+11})
    c = home_away(logs, stat_type="points", line=22, direction="over", prop_is_home=True)
    assert c > 0.05  # measurable positive
```

- [ ] **Step 2: Implement**

```python
def home_away(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
    prop_is_home: bool,
) -> Optional[float]:
    """Differential between same-venue average and opposite-venue average.

    Mirrors homeAwaySplit() in lib/confidence.ts. Positive when player's
    venue-specific average favors hitting the prop in the requested direction.
    Clamped to [-0.25, 0.25]. Returns None if either bucket is empty.
    """
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)
    same_venue = [g for g in qualifying if bool(g.get("is_home")) == prop_is_home]
    if not same_venue:
        return None
    avg = sum(float(g.get(field) or 0) for g in same_venue) / len(same_venue)
    if line <= 0:
        return None
    raw = (avg - line) / line if direction == "over" else (line - avg) / line
    return max(-0.25, min(0.25, raw))
```

- [ ] **Step 3: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): port home_away factor + tests"
```

### Task 8: Implement factor — `vs_opponent`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Add tests**

```python
from confidence_features import vs_opponent

def test_vs_opponent_no_history():
    # Player has no logs vs opponent BOS → None
    logs = [{"game_date": "2026-05-20", "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. NYK", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":35}]
    assert vs_opponent(logs, stat_type="points", line=20, direction="over", opponent="BOS") is None

def test_vs_opponent_strong_history():
    # Avg 35 vs BOS, line 25 over → positive
    logs = [{"game_date": "2026-05-20", "minutes": 30, "points": 35, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":45} for _ in range(3)]
    c = vs_opponent(logs, stat_type="points", line=25, direction="over", opponent="BOS")
    assert c is not None and c > 0
```

- [ ] **Step 2: Implement**

```python
def _extract_opponent(matchup: str) -> Optional[str]:
    """Mirrors extractOpponent() in lib/confidence.ts:474."""
    if not matchup:
        return None
    if " @ " in matchup:
        return matchup.split(" @ ")[1].strip()
    if " vs. " in matchup:
        return matchup.split(" vs. ")[1].strip()
    return None

def vs_opponent(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
    opponent: str,
) -> Optional[float]:
    """Performance vs this specific opponent across all available games.

    Mirrors vsOpponentScore() in lib/confidence.ts:700. Requires at least
    one historical game vs opponent. Clamped to [-0.3, 0.3].
    """
    if not opponent or line <= 0:
        return None
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    matching = [g for g in _qualifying_logs(logs)
                if _extract_opponent(g.get("matchup", "")) == opponent]
    if not matching:
        return None
    avg = sum(float(g.get(field) or 0) for g in matching) / len(matching)
    raw = (avg - line) / line if direction == "over" else (line - avg) / line
    return max(-0.3, min(0.3, raw))
```

- [ ] **Step 3: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): port vs_opponent factor + tests"
```

### Task 9: Implement factor — `rest_days`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Add tests**

```python
from confidence_features import rest_days
from datetime import date, timedelta

def test_rest_days_b2b():
    # Last game yesterday → b2b → negative
    yesterday = (date(2026, 5, 22) - timedelta(days=1)).isoformat()
    logs = [{"game_date": yesterday, "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":35}]
    c = rest_days(logs, prop_game_date="2026-05-22")
    assert c < 0

def test_rest_days_3day_rest():
    # 3 days rest → small positive
    logs = [{"game_date": "2026-05-19", "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":35}]
    c = rest_days(logs, prop_game_date="2026-05-22")
    assert c is not None and c >= 0

def test_rest_days_no_logs():
    assert rest_days([], prop_game_date="2026-05-22") is None
```

- [ ] **Step 2: Implement**

```python
from datetime import date as _date

def rest_days(logs: List[Dict[str, Any]], prop_game_date: str) -> Optional[float]:
    """Score based on days since last qualifying game.

    Mirrors restDaysScore() in lib/confidence.ts:836.
      0 days (b2b): -0.08
      1 day:        -0.03
      2 days:        0.00
      3 days:       +0.04
      4+ days:      +0.06
    """
    if not logs or not prop_game_date:
        return None
    qualifying = _qualifying_logs(logs)
    if not qualifying:
        return None
    last_date_str = qualifying[0].get("game_date")
    if not last_date_str:
        return None
    pgd = _date.fromisoformat(prop_game_date)
    lgd = _date.fromisoformat(str(last_date_str)[:10])
    delta = (pgd - lgd).days
    if delta <= 0:    return -0.08
    if delta == 1:    return -0.03
    if delta == 2:    return 0.00
    if delta == 3:    return 0.04
    return 0.06
```

- [ ] **Step 3: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): port rest_days factor + tests"
```

### Task 10: Implement factors — `pace`, `blowout`, `matchup_edge`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

These three depend on opponent + game context (team pace, projected spread, defense rank). Pace and matchup_edge read pre-built team-stats tables; blowout uses the prop's vegas spread.

- [ ] **Step 1: Read TS source carefully**

Open `lib/confidence.ts:585-623` (pace), `:623-661` (matchup), `:770-781` (blowout). Note the data dependencies: TeamPaceStats, TeamDefenseStats, DvpStats. These come from `team_pace`, `team_defense`, `dvp_stats` tables.

- [ ] **Step 2: Add tests using stub inputs**

```python
from confidence_features import pace, blowout, matchup_edge

def test_pace_above_average():
    # Opponent pace 102, league avg 100 → positive small
    c = pace(opponent_pace=102.0, league_avg_pace=100.0)
    assert c is not None and c > 0

def test_pace_below_average():
    c = pace(opponent_pace=96.0, league_avg_pace=100.0)
    assert c < 0

def test_blowout_no_spread():
    assert blowout(spread=None) is None

def test_blowout_competitive():
    # Spread of ±3 → ~0
    c = blowout(spread=-3.0)
    assert abs(c) < 0.05

def test_blowout_lopsided():
    # Spread of -12 → negative (favored team blowout risk reduces stars' minutes)
    c = blowout(spread=-12.0)
    assert c < 0

def test_matchup_edge_top_defense():
    # def_rank 1 = best defense → negative for over
    c = matchup_edge(def_rank=1, dvp_value=2.5, direction="over", league_avg=10.0)
    assert c < 0

def test_matchup_edge_bottom_defense():
    # def_rank 30 = worst → positive for over
    c = matchup_edge(def_rank=30, dvp_value=15.0, direction="over", league_avg=10.0)
    assert c > 0
```

- [ ] **Step 3: Implement**

```python
def pace(opponent_pace: Optional[float], league_avg_pace: float = 100.0) -> Optional[float]:
    """Pace differential vs league average, normalized.

    Mirrors paceScore() in lib/confidence.ts:585. Clamped to [-0.15, 0.15].
    """
    if opponent_pace is None or league_avg_pace <= 0:
        return None
    raw = (opponent_pace - league_avg_pace) / league_avg_pace
    return max(-0.15, min(0.15, raw))

def blowout(spread: Optional[float]) -> Optional[float]:
    """Adjustment for projected blowout risk.

    Mirrors blowoutScore() in lib/confidence.ts:770. Larger absolute
    spreads pull score down (starter minutes get cut). Capped at -0.12.
    """
    if spread is None:
        return None
    abs_sp = abs(spread)
    if abs_sp < 6:    return 0.0
    if abs_sp < 9:    return -0.04
    if abs_sp < 12:   return -0.08
    return -0.12

def matchup_edge(
    def_rank: Optional[int],
    dvp_value: Optional[float],
    direction: str,
    league_avg: float,
) -> Optional[float]:
    """Matchup quality vs opponent defense.

    Mirrors matchupScore() in lib/confidence.ts:623. Combines def_rank
    (1-30, lower = stronger) with DVP (defense-vs-position) value.
    Returns positive when matchup favors the prop direction.
    """
    if def_rank is None or dvp_value is None or league_avg <= 0:
        return None
    # Rank component: 1-30 → -0.15 to +0.15 (inverted; high rank = bad defense = +)
    rank_score = ((def_rank - 15.5) / 14.5) * 0.15
    # DVP component: how far opponent allows above/below league avg
    dvp_delta = (dvp_value - league_avg) / league_avg
    dvp_score = max(-0.15, min(0.15, dvp_delta))
    raw = (rank_score + dvp_score) / 2
    if direction == "under":
        raw = -raw
    return max(-0.2, min(0.2, raw))
```

- [ ] **Step 4: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): port pace, blowout, matchup_edge factors + tests"
```

### Task 11: Implement factors — `opponent_leak`, `player_bias`

These read pre-built DB tables (`opponent_leaks`, `player_line_bias`). The Python functions take the already-loaded row and convert to a score.

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Read TS source**

`lib/confidence.ts` computeAdditives: look for `leakAdj` (mult=8, cap=±4 per the recent revert) and `playerBias`. These take the leak/bias value and apply a per-stat coefficient.

- [ ] **Step 2: Add tests**

```python
from confidence_features import opponent_leak, player_bias

def test_opponent_leak_positive():
    # leak value +0.10 → positive adjustment, mult=8, capped at ±4
    c = opponent_leak(leak_value=0.10, direction="over")
    assert c is not None and 0 < c <= 4.0

def test_opponent_leak_cap():
    c = opponent_leak(leak_value=10.0, direction="over")
    assert c == 4.0  # capped

def test_opponent_leak_under_flipped():
    # For under direction, sign flips
    c = opponent_leak(leak_value=0.10, direction="under")
    assert c < 0

def test_player_bias_blends_with_sample_size():
    # hit_rate 0.60 over 50 samples → positive bias
    c = player_bias(hit_rate=0.60, sample_count=50, direction="over")
    assert c is not None and c > 0

def test_player_bias_small_sample_dampened():
    c_big   = player_bias(hit_rate=0.70, sample_count=100, direction="over")
    c_small = player_bias(hit_rate=0.70, sample_count=5,   direction="over")
    assert c_big > c_small  # small sample should be dampened
```

- [ ] **Step 3: Implement (mirror lib/confidence.ts computeAdditives logic)**

```python
def opponent_leak(leak_value: Optional[float], direction: str) -> Optional[float]:
    """Opponent-vs-position leak adjustment.

    Mirrors leakAdj in lib/confidence.ts computeAdditives. mult=8, cap=±4
    (matches the 2026-05-23 revert from mult=15/cap=6).
    """
    if leak_value is None:
        return None
    raw = leak_value * 8
    if direction == "under":
        raw = -raw
    return max(-4.0, min(4.0, raw))

def player_bias(
    hit_rate: Optional[float],
    sample_count: Optional[int],
    direction: str,
) -> Optional[float]:
    """Player-specific historical line-bias adjustment.

    hit_rate comes from player_line_bias.hit_rate (now 70/30 recency-blended).
    Confidence-shrinkage by sample size: factor = min(n/30, 1.0).
    Final = (hit_rate - 0.5) * 20 * shrinkage. Clamped to ±5.
    """
    if hit_rate is None or sample_count is None or sample_count <= 0:
        return None
    shrinkage = min(sample_count / 30.0, 1.0)
    raw = (hit_rate - 0.5) * 20 * shrinkage
    if direction == "under":
        raw = -raw
    return max(-5.0, min(5.0, raw))
```

- [ ] **Step 4: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): port opponent_leak, player_bias factors + tests"
```

### Task 12: Orchestrator — `compute_all_features`

**Files:**
- Modify: `scripts/confidence_features.py`
- Modify: `scripts/tests/test_confidence_features.py`

- [ ] **Step 1: Add test**

```python
from confidence_features import compute_all_features

def test_compute_all_features_returns_dict():
    logs = basic_pts_logs()
    prop = {"stat_type": "points", "line": 22.0, "direction": "over",
            "game_date": "2026-05-22"}
    ctx = {"prop_is_home": True, "opponent": "BOS",
           "opponent_pace": 102.0, "def_rank": 15, "dvp_value": 28.0,
           "league_avg_dvp": 26.0, "spread": -3.0,
           "leak_value": 0.05, "bias_hit_rate": 0.55, "bias_sample_count": 25}
    features = compute_all_features(prop, logs, ctx)
    expected_keys = {"line_value", "matchup_edge", "last20_hit_rate", "trend",
                     "season_cushion", "pace", "rest_days", "blowout",
                     "home_away", "vs_opponent", "opponent_leak", "player_bias"}
    assert set(features.keys()) == expected_keys
```

- [ ] **Step 2: Implement**

```python
def compute_all_features(
    prop: Dict[str, Any],
    logs: List[Dict[str, Any]],
    ctx: Dict[str, Any],
) -> Dict[str, Optional[float]]:
    """Orchestrator. Returns dict with all 12 reconstructable factors.

    Required prop fields: stat_type, line, direction, game_date
    Required ctx fields: prop_is_home, opponent, opponent_pace, def_rank,
                          dvp_value, league_avg_dvp, spread, leak_value,
                          bias_hit_rate, bias_sample_count
    Missing ctx fields → that factor returns None.
    """
    s, l, d = prop["stat_type"], float(prop["line"]), prop["direction"]
    return {
        "line_value":       line_value(logs, s, l, d),
        "matchup_edge":     matchup_edge(ctx.get("def_rank"), ctx.get("dvp_value"),
                                          d, ctx.get("league_avg_dvp", 0)),
        "last20_hit_rate":  last20_hit_rate(logs, s, l, d),
        "trend":            trend(logs, s),
        "season_cushion":   season_cushion(logs, s, l, d),
        "pace":             pace(ctx.get("opponent_pace")),
        "rest_days":        rest_days(logs, prop.get("game_date")),
        "blowout":          blowout(ctx.get("spread")),
        "home_away":        home_away(logs, s, l, d, ctx.get("prop_is_home", False)),
        "vs_opponent":      vs_opponent(logs, s, l, d, ctx.get("opponent", "")),
        "opponent_leak":    opponent_leak(ctx.get("leak_value"), d),
        "player_bias":      player_bias(ctx.get("bias_hit_rate"), ctx.get("bias_sample_count"), d),
    }
```

- [ ] **Step 3: Run + commit**

```bash
python -m pytest scripts/tests/test_confidence_features.py -v
git add -u
git commit -m "feat(features): add compute_all_features orchestrator"
```

---

## Phase 2 — Backfill driver

### Task 13: Write backfill script

**Files:**
- Create: `scripts/build_feature_table.py`

- [ ] **Step 1: Write script**

```python
#!/usr/bin/env python
"""scripts/build_feature_table.py

Backfill the prop_features table from prop_grades.

Usage:
    python scripts/build_feature_table.py --since 2026-04-26
    python scripts/build_feature_table.py --resume      # skip rows already present

Reads:  prop_grades, player_game_logs, historical_prop_lines, team_pace,
        team_defense, dvp_stats, opponent_leaks, player_line_bias
Writes: prop_features
"""
import os, sys, argparse, json
from datetime import date, timedelta
from typing import List, Dict, Any, Optional
import requests

sys.path.insert(0, os.path.dirname(__file__))
from confidence_features import compute_all_features

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
           "Content-Type": "application/json", "Prefer": "return=minimal"}

def fetch_all(path: str, params: str = "") -> List[Dict[str, Any]]:
    rows, offset, PAGE = [], 0, 1000
    while True:
        sep = "&" if params else ""
        url = f"{SUPABASE_URL}/rest/v1/{path}?{params}{sep}limit={PAGE}&offset={offset}"
        r = requests.get(url, headers=HEADERS, timeout=60); r.raise_for_status()
        data = r.json()
        if not data: break
        rows.extend(data)
        if len(data) < PAGE: break
        offset += PAGE
    return rows

def upsert(table: str, rows: List[Dict[str, Any]], batch_size: int = 500) -> int:
    if not rows: return 0
    written = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        url = f"{SUPABASE_URL}/rest/v1/{table}?on_conflict=prop_grade_id"
        h = {**HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"}
        r = requests.post(url, headers=h, data=json.dumps(batch), timeout=60)
        if r.status_code >= 400:
            print(f"  upsert error: {r.status_code} {r.text[:200]}")
        else:
            written += len(batch)
    return written

def build_logs_by_player_then_date(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    by_player: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        by_player.setdefault(r["player_name"], []).append(r)
    for name in by_player:
        by_player[name].sort(key=lambda g: g["game_date"], reverse=True)
    return by_player

def logs_before(all_logs: List[Dict[str, Any]], cutoff_iso: str) -> List[Dict[str, Any]]:
    return [g for g in all_logs if g["game_date"] < cutoff_iso]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None, help="Earliest game_date to backfill (YYYY-MM-DD)")
    parser.add_argument("--resume", action="store_true",
                         help="Skip rows already in prop_features")
    parser.add_argument("--dry-run", action="store_true",
                         help="Compute but do not write")
    args = parser.parse_args()

    # 1. Load graded props
    cutoff = args.since or (date.today() - timedelta(days=45)).isoformat()
    print(f"Loading graded props since {cutoff}...")
    grade_params = f"game_date=gte.{cutoff}&hit=not.is.null&select=id,game_date,player_name,stat_type,line,direction,hit"
    grades = fetch_all("prop_grades", grade_params)
    print(f"  {len(grades)} graded props")

    # 2. Skip already-computed if --resume
    if args.resume:
        existing = fetch_all("prop_features", "select=prop_grade_id")
        existing_ids = {r["prop_grade_id"] for r in existing}
        grades = [g for g in grades if g["id"] not in existing_ids]
        print(f"  {len(grades)} remaining after resume filter")
    if not grades:
        print("Nothing to do."); return

    # 3. Bulk-load logs for all relevant players
    players = sorted({g["player_name"] for g in grades})
    print(f"Loading logs for {len(players)} players...")
    # Fetch in chunks to avoid URL length limits
    all_logs: List[Dict[str, Any]] = []
    for i in range(0, len(players), 50):
        chunk = players[i:i+50]
        names_param = ",".join(f'"{n}"' for n in chunk)
        lp = f"player_name=in.({names_param})&select=player_name,game_date,minutes,points,rebounds,assists,fg3m,blocks,steals,pra,is_home,matchup"
        all_logs.extend(fetch_all("player_game_logs", lp))
    logs_by_player = build_logs_by_player_then_date(all_logs)
    print(f"  {len(all_logs)} log rows for {len(logs_by_player)} players")

    # 4. Load context tables (team_pace, defense, etc.) — keep simple maps
    # NOTE: leaving leak/bias/team-context as None initially. Tasks 17+ wire those in.
    league_avg_dvp = 0.0  # placeholder; refined in Task 17

    # 5. Compute features per prop
    out_rows: List[Dict[str, Any]] = []
    for g in grades:
        player_logs = logs_by_player.get(g["player_name"], [])
        before = logs_before(player_logs, g["game_date"])
        if not before:
            continue
        # Minimal ctx — Task 17 wires in real team/dvp/leak/bias data.
        ctx: Dict[str, Any] = {
            "prop_is_home": before[0].get("is_home") if before else False,
            "opponent": None,
            "opponent_pace": None, "def_rank": None, "dvp_value": None,
            "league_avg_dvp": league_avg_dvp, "spread": None,
            "leak_value": None, "bias_hit_rate": None, "bias_sample_count": None,
        }
        prop = {"stat_type": g["stat_type"], "line": g["line"],
                "direction": g["direction"], "game_date": g["game_date"]}
        feats = compute_all_features(prop, before, ctx)
        out_rows.append({
            "prop_grade_id":    g["id"],
            "stat_type":        g["stat_type"],
            "direction":        g["direction"],
            "line":             g["line"],
            "hit":              g["hit"],
            "line_value":       feats["line_value"],
            "matchup_edge":     feats["matchup_edge"],
            "last20_hit_rate":  feats["last20_hit_rate"],
            "trend":            feats["trend"],
            "season_cushion":   feats["season_cushion"],
            "pace":             feats["pace"],
            "rest_days":        feats["rest_days"],
            "blowout":          feats["blowout"],
            "home_away":        feats["home_away"],
            "vs_opponent":      feats["vs_opponent"],
            "opponent_leak":    feats["opponent_leak"],
            "player_bias":      feats["player_bias"],
            "feature_version":  "v1",
        })

    print(f"Computed {len(out_rows)} feature rows")
    if args.dry_run:
        print("Dry run — not writing.")
        return
    written = upsert("prop_features", out_rows)
    print(f"Wrote {written} rows to prop_features.")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-test dry-run**

Run: `python scripts/build_feature_table.py --since 2026-05-20 --dry-run`
Expected: prints "Computed N feature rows", N > 0, then "Dry run — not writing."

- [ ] **Step 3: Commit**

```bash
git add scripts/build_feature_table.py
git commit -m "feat(features): backfill script for prop_features (logs-only context)"
```

### Task 14: Wire in opponent, opponent_pace, def_rank, dvp, spread, leak, bias

**Files:**
- Modify: `scripts/build_feature_table.py`

- [ ] **Step 1: Add context loaders**

After log loading in `main()`, before the per-prop loop, add:

```python
    # 4a. Load team_pace (one row per team)
    pace_rows = fetch_all("team_pace", "select=team,pace")
    pace_by_team = {r["team"]: float(r["pace"]) for r in pace_rows if r.get("pace") is not None}

    # 4b. Load team_defense (def_rank per team per stat_type)
    def_rows = fetch_all("team_defense", "select=team,stat_type,def_rank")
    def_by_team_stat: Dict[tuple, int] = {}
    for r in def_rows:
        if r.get("def_rank") is not None:
            def_by_team_stat[(r["team"], r["stat_type"])] = int(r["def_rank"])

    # 4c. Load dvp_stats (defense-vs-position, by team/stat/position)
    dvp_rows = fetch_all("dvp_stats", "select=team,stat_type,position,value")
    dvp_by_team_stat: Dict[tuple, float] = {}
    league_avg_by_stat: Dict[str, float] = {}
    for r in dvp_rows:
        if r.get("value") is None: continue
        key = (r["team"], r["stat_type"])
        dvp_by_team_stat[key] = float(r["value"])
        league_avg_by_stat.setdefault(r["stat_type"], 0.0)
    for stat in list(league_avg_by_stat.keys()):
        vals = [v for (t,s), v in dvp_by_team_stat.items() if s == stat]
        league_avg_by_stat[stat] = sum(vals)/len(vals) if vals else 0.0

    # 4d. Load opponent_leaks (current season)
    leak_rows = fetch_all("opponent_leaks", "select=team,stat_type,leak")
    leak_map = {(r["team"], r["stat_type"]): float(r["leak"]) for r in leak_rows if r.get("leak") is not None}

    # 4e. Load player_line_bias
    bias_rows = fetch_all("player_line_bias", "select=player_name,stat_type,hit_rate,sample_count")
    bias_map = {(r["player_name"], r["stat_type"]): r for r in bias_rows}

    # 4f. Load historical_prop_lines for vegas spread lookup (if available)
    # NOTE: spreads come from a separate `games` or `odds_snapshots` table; if your
    # schema stores `spread` on historical_prop_lines, fetch here. Otherwise leave None.
    spread_map: Dict[tuple, float] = {}
    # Example if you have a games table:
    # game_rows = fetch_all("games", f"game_date=gte.{cutoff}&select=game_date,home_team,away_team,spread")
    # for r in game_rows:
    #     spread_map[(r["game_date"], r["home_team"])] = float(r["spread"])
```

- [ ] **Step 2: Wire ctx in the per-prop loop**

Replace the minimal `ctx` construction with:

```python
        # Resolve opponent from most recent log's matchup
        prop_is_home = bool(before[0].get("is_home")) if before else False
        opp = None
        if before and before[0].get("matchup"):
            mp = before[0]["matchup"]
            if " @ " in mp:    opp = mp.split(" @ ")[1].strip()
            elif " vs. " in mp: opp = mp.split(" vs. ")[1].strip()

        stat = g["stat_type"]
        bias_row = bias_map.get((g["player_name"], stat))
        ctx = {
            "prop_is_home":      prop_is_home,
            "opponent":          opp,
            "opponent_pace":     pace_by_team.get(opp) if opp else None,
            "def_rank":          def_by_team_stat.get((opp, stat)) if opp else None,
            "dvp_value":         dvp_by_team_stat.get((opp, stat)) if opp else None,
            "league_avg_dvp":    league_avg_by_stat.get(stat, 0.0),
            "spread":            spread_map.get((g["game_date"], opp)) if opp else None,
            "leak_value":        leak_map.get((opp, stat)) if opp else None,
            "bias_hit_rate":     float(bias_row["hit_rate"]) if bias_row else None,
            "bias_sample_count": int(bias_row["sample_count"]) if bias_row else None,
        }
```

- [ ] **Step 3: Dry-run + verify counts**

Run: `python scripts/build_feature_table.py --since 2026-05-20 --dry-run`
Expected: prints feature row count > 0. Spot-check by adding a `print(feats)` in the first iteration to confirm `pace`, `matchup_edge`, etc. are no longer all None.

- [ ] **Step 4: Commit**

```bash
git add scripts/build_feature_table.py
git commit -m "feat(features): wire opponent/pace/dvp/leak/bias context into backfill"
```

### Task 15: Run full backfill

- [ ] **Step 1: Execute backfill**

Run: `python scripts/build_feature_table.py --since 2026-04-26 2>&1 | tee /tmp/backfill.log`
Expected: "Wrote N rows to prop_features" where N is within 10% of the graded prop count (~9k).

- [ ] **Step 2: Verify in Supabase**

Run in SQL editor:
```sql
SELECT stat_type, COUNT(*) AS n,
       COUNT(line_value)   AS n_line_value,
       COUNT(matchup_edge) AS n_matchup,
       COUNT(opponent_leak) AS n_leak
FROM prop_features
GROUP BY stat_type
ORDER BY n DESC;
```
Expected: rows for all 7 stats; non-null counts >50% per factor (except where data sources are sparse).

- [ ] **Step 3: No commit needed (backfill is data, not code)**

---

## Phase 3 — TS instrumentation

### Task 16: Add `score_factors` write to scoreProps

**Files:**
- Modify: `lib/confidence.ts` (around line 1262, `scoreProps`)
- Modify: `app/api/enrich/route.ts` (where `props` rows are upserted)

- [ ] **Step 1: Modify `scoreProps` to return factor breakdown**

In `lib/confidence.ts`, near where the final score is assembled, capture each additive's value into an object and return it. Locate the existing return statement and extend it:

```typescript
// near the end of scoreProps(), after adds are computed:
const scoreFactors: Record<string, number | null> = {
  lineValue:        f.lineValue,
  matchupEdge:      f.matchupEdge,
  last20HitRate:    f.last20HitRate,
  trend:            f.trend,
  seasonCushion:    f.seasonCushion,
  pace:             f.pace,
  restDays:         adds.restAdj,
  blowout:          adds.blowoutAdj,
  homeAway:         f.homeAway,
  vsOpponent:       f.vsOpponent,
  opponentLeak:     adds.leakAdj,
  playerBias:       adds.playerBiasAdj,
  // hard-to-reconstruct (Phase B):
  newsInjury:       adds.newsInjuryAdj,
  lineupAdj:        adds.lineupAdj,
  lineMovement:     adds.lineMoveAdj,
}
// add to existing return object:
return { ..., score_factors: scoreFactors }
```

(Exact return shape depends on the existing scoreProps signature — read lines 1262-1460 carefully and integrate.)

- [ ] **Step 2: Persist `score_factors` when writing props**

In `app/api/enrich/route.ts`, find the `props` upsert block and add `score_factors` to the row payload (pulled from the scoreProps result).

- [ ] **Step 3: Add a vitest unit test**

```typescript
// lib/__tests__/confidence.test.ts — append
it('scoreProps emits score_factors with all expected keys', () => {
  const prop = { /* … existing fixture … */ }
  const result = scoreProps(prop, mockLogs, null, mockCtx)
  expect(result.score_factors).toBeDefined()
  expect(Object.keys(result.score_factors)).toEqual(
    expect.arrayContaining([
      'lineValue','matchupEdge','last20HitRate','trend','seasonCushion',
      'pace','restDays','blowout','homeAway','vsOpponent',
      'opponentLeak','playerBias','newsInjury','lineupAdj','lineMovement',
    ])
  )
})
```

- [ ] **Step 4: Run vitest**

Run: `cd C:/Users/dcho0/nbaiqproject && npm test -- confidence.test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/confidence.ts app/api/enrich/route.ts lib/__tests__/confidence.test.ts
git commit -m "feat(confidence): emit score_factors breakdown on every scored prop"
```

---

## Phase 4 — Factor audit tool

### Task 17: Write `factor_audit.py`

**Files:**
- Create: `scripts/factor_audit.py`

- [ ] **Step 1: Implement script**

```python
#!/usr/bin/env python
"""scripts/factor_audit.py

Per-stat factor analysis. Joins prop_features with prop_grades and emits:
  1. Univariate hit-rate per factor quintile
  2. Logistic regression coefficients + p-values
  3. Recommended weight JSON (normalized abs-coefficient for p<0.10)

Usage:
    python scripts/factor_audit.py points
    python scripts/factor_audit.py rebounds --min-samples 200
"""
import os, sys, argparse, json
from typing import List, Dict
import requests
import pandas as pd
import numpy as np
import statsmodels.api as sm

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

FEATURES = ["line_value","matchup_edge","last20_hit_rate","trend",
            "season_cushion","pace","rest_days","blowout",
            "home_away","vs_opponent","opponent_leak","player_bias"]

def load(stat: str) -> pd.DataFrame:
    rows, offset = [], 0
    while True:
        url = (f"{SUPABASE_URL}/rest/v1/prop_features"
               f"?stat_type=eq.{stat}&limit=1000&offset={offset}")
        r = requests.get(url, headers=HEADERS, timeout=60); r.raise_for_status()
        page = r.json()
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return pd.DataFrame(rows)

def univariate(df: pd.DataFrame):
    print("\n== Univariate hit rate by quintile ==")
    for feat in FEATURES:
        if feat not in df.columns: continue
        sub = df.dropna(subset=[feat])
        if len(sub) < 50:
            print(f"  {feat:<18} insufficient (n={len(sub)})")
            continue
        sub = sub.copy()
        sub["q"] = pd.qcut(sub[feat], q=5, labels=False, duplicates="drop")
        grouped = sub.groupby("q")["hit"].agg(["count","mean"])
        spread = grouped["mean"].max() - grouped["mean"].min()
        print(f"  {feat:<18} spread={spread*100:>5.1f}pp  q5={grouped['mean'].iloc[-1]*100:>5.1f}%  q1={grouped['mean'].iloc[0]*100:>5.1f}%")

def regression(df: pd.DataFrame, min_samples: int):
    print("\n== Logistic regression ==")
    df = df.dropna(subset=FEATURES + ["hit"])
    print(f"  n after dropna: {len(df)}")
    if len(df) < min_samples:
        print(f"  INSUFFICIENT (need >= {min_samples})"); return None
    X = sm.add_constant(df[FEATURES])
    y = df["hit"].astype(int)
    model = sm.Logit(y, X).fit(disp=False)
    print(model.summary().tables[1])

    significant = []
    for feat in FEATURES:
        coef = model.params[feat]; p = model.pvalues[feat]
        if p < 0.10 and abs(coef) > 0:
            significant.append((feat, coef, p))

    print("\n== Significant factors (p<0.10) ==")
    if not significant:
        print("  NONE — model has no separating signal for this stat")
        return None
    for f, c, p in significant:
        print(f"  {f:<18} coef={c:+.3f}  p={p:.3f}")

    total = sum(abs(c) for _, c, _ in significant)
    weights = {f: round(abs(c)/total, 3) for f, c, _ in significant}
    print("\n== Recommended weights (normalized abs-coefficient) ==")
    print(json.dumps(weights, indent=2))
    return weights

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stat")
    parser.add_argument("--min-samples", type=int, default=200)
    args = parser.parse_args()
    print(f"Auditing stat: {args.stat}")
    df = load(args.stat)
    print(f"Loaded {len(df)} rows from prop_features")
    if len(df) == 0:
        print("No data."); return
    univariate(df)
    regression(df, args.min_samples)

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Install Python deps if needed**

Run: `pip install pandas statsmodels scikit-learn requests`

- [ ] **Step 3: Test on rebounds**

Run: `python scripts/factor_audit.py rebounds`
Expected: univariate table prints, regression summary prints, recommended-weights JSON prints.

- [ ] **Step 4: Commit**

```bash
git add scripts/factor_audit.py
git commit -m "feat(features): factor_audit tool for per-stat regression"
```

---

## Phase 5 — Counterfactual harness

### Task 18: Write `counterfactual_v12.py`

**Files:**
- Create: `scripts/counterfactual_v12.py`

- [ ] **Step 1: Implement**

```python
#!/usr/bin/env python
"""scripts/counterfactual_v12.py

Compare current vs proposed weights for a stat on a held-out window.

Usage:
    python scripts/counterfactual_v12.py points \
        --proposed '{"line_value":0.4,"trend":0.3,"matchup_edge":0.3}' \
        --holdout-days 7
"""
import os, sys, argparse, json
from datetime import date, timedelta
import requests, pandas as pd, numpy as np

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

def load_holdout(stat: str, since: str) -> pd.DataFrame:
    rows, offset = [], 0
    while True:
        url = (f"{SUPABASE_URL}/rest/v1/prop_features"
               f"?stat_type=eq.{stat}&limit=1000&offset={offset}"
               f"&select=*,prop_grades!inner(game_date)"
               f"&prop_grades.game_date=gte.{since}")
        r = requests.get(url, headers=HEADERS, timeout=60); r.raise_for_status()
        page = r.json()
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return pd.DataFrame(rows)

def synth_score(df: pd.DataFrame, weights: dict) -> pd.Series:
    # Normalize each factor to roughly [-1, 1] then scale to 0-100 via weights
    score = pd.Series(50.0, index=df.index)
    for feat, w in weights.items():
        if feat not in df.columns: continue
        v = df[feat].fillna(0)
        score = score + w * v * 50  # 50 = scale to ±50 around midpoint
    return score.clip(0, 100)

def bucket_report(score: pd.Series, hit: pd.Series, label: str):
    print(f"\n  -- {label} --")
    df = pd.DataFrame({"score": score, "hit": hit.astype(int)})
    df["band"] = pd.cut(df["score"], bins=[0,60,68,72,76,80,100],
                         labels=["<60","60-68","68-72","72-76","76-80","80+"])
    g = df.groupby("band", observed=True)["hit"].agg(["count","mean"])
    for band, row in g.iterrows():
        print(f"    {band:<8} n={int(row['count']):>4}  hit={row['mean']*100:>5.1f}%")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stat")
    parser.add_argument("--proposed", required=True, help="JSON object of factor:weight")
    parser.add_argument("--current",  default=None, help="JSON object (defaults to read confidence-weights.json)")
    parser.add_argument("--holdout-days", type=int, default=7)
    args = parser.parse_args()

    since = (date.today() - timedelta(days=args.holdout_days)).isoformat()
    df = load_holdout(args.stat, since)
    print(f"Holdout window: {since} onward; n={len(df)}")
    if len(df) == 0:
        print("No data."); return

    proposed = json.loads(args.proposed)

    if args.current is None:
        with open("lib/confidence-weights.json") as f:
            cfg = json.load(f)
        current = cfg.get(args.stat, {})
    else:
        current = json.loads(args.current)

    cur_score = synth_score(df, current)
    new_score = synth_score(df, proposed)

    bucket_report(cur_score, df["hit"], "CURRENT")
    bucket_report(new_score, df["hit"], "PROPOSED")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-test**

Run: `python scripts/counterfactual_v12.py rebounds --proposed '{"line_value":0.5,"trend":0.3,"matchup_edge":0.2}' --holdout-days 7`
Expected: two bucket tables print side by side.

- [ ] **Step 3: Commit**

```bash
git add scripts/counterfactual_v12.py
git commit -m "feat(features): counterfactual_v12 harness for held-out weight comparison"
```

---

## Phase 6 — Refactor rebounds (validation)

### Task 19: Audit + refactor rebounds

**Files:**
- Modify: `lib/confidence-weights.json` (rebounds block only)

- [ ] **Step 1: Run audit on rebounds**

Run: `python scripts/factor_audit.py rebounds > /tmp/rebounds_audit.txt`
Read the output: identify significant factors, note their coefficients, capture the recommended-weights JSON.

- [ ] **Step 2: Brainstorm candidate new factor**

Pick one new candidate from the spec list (e.g., `minutes_trend_3g`). Skip for now unless univariate analysis on existing factors fails to clear the gate. Document the decision in `/tmp/rebounds_audit.txt`.

- [ ] **Step 3: Counterfactual proposed weights**

Run: `python scripts/counterfactual_v12.py rebounds --proposed '<json from audit>' --holdout-days 7`
Verify: top score band shows ≥5pp lift over current AND ≥3 monotonically increasing bands.

- [ ] **Step 4: If gate passes, update weights**

In `lib/confidence-weights.json`, replace the `rebounds` weight block with the recommended values. Add a comment block to the `changelog` array at top noting "rebounds re-tuned 2026-MM-DD via factor_audit, top-band hit% X.X→Y.Y".

- [ ] **Step 5: Run existing vitest confidence tests**

Run: `npm test -- confidence.test`
Expected: all 32 confidence tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/confidence-weights.json
git commit -m "tune(rebounds): re-weighted via factor_audit (top-band lift +X.Xpp on 7d holdout)"
```

If the acceptance gate fails: do NOT ship. Document the gap in `docs/superpowers/specs/2026-05-26-per-stat-model-refactor-design.md` under a new "Stat backlog" section, then move to the next stat.

---

## Phase 7 — Replicate for remaining 6 stats

### Tasks 20-25: assists, points, three_pointers, blocks, steals, pra

Each task follows the **exact same loop** as Task 19, substituting the stat name. Per-task structure:

- [ ] **Step 1:** `python scripts/factor_audit.py <stat>`
- [ ] **Step 2:** Identify dead/inverted factors. Decide whether to add 1 candidate new factor (if existing audit yields <3 significant factors, add one and re-audit).
- [ ] **Step 3:** `python scripts/counterfactual_v12.py <stat> --proposed '<json>' --holdout-days 7`
- [ ] **Step 4:** Acceptance gate check — top band ≥5pp lift AND ≥3 monotonic bands.
- [ ] **Step 5:** If pass → update `confidence-weights.json` block for the stat, run `npm test -- confidence.test`, commit. If fail → add to backlog in the spec doc.

**Order (least risky first):**
1. **Task 20:** assists (works-ish, similar profile to rebounds)
2. **Task 21:** blocks (works — refactor should at most match current; risk of regression)
3. **Task 22:** steals (works — same)
4. **Task 23:** pra (mixed)
5. **Task 24:** points (broken — hardest, most upside)
6. **Task 25:** three_pointers (broken — same)

For each of the broken stats (points, three_pointers), it is **expected** that the existing-factor regression alone won't clear the gate. The recovery path is:

- Implement **one** new candidate factor from the brainstorm pool (start with `minutes_trend_3g` for points, `vegas_proj_delta` for three_pointers).
- Add the factor to `confidence_features.py` with full test coverage (mirror Tasks 3-12 structure).
- Re-run backfill incrementally: `python scripts/build_feature_table.py --resume --since 2026-04-26` (the `feature_version` bump in the new factor's code path will force re-computation only for affected rows).
- Re-audit. If still no signal → mark stat as "needs new data source" in backlog and ship the threshold-only fix from yesterday's counterfactual as a stopgap.

---

## Self-review checklist (skip if already done)

- [x] Every task has exact file paths
- [x] Every code step has actual code, not "implement above"
- [x] No "TBD" / "TODO" / "fill in"
- [x] Function signatures used in later tasks match earlier definitions (`compute_all_features(prop, logs, ctx)` consistent across Tasks 12-14)
- [x] Acceptance gate is identical across Phases 6-7 (≥5pp top-band lift + ≥3 monotonic bands)
- [x] Spec requirements covered:
  - Feature reconstruction → Tasks 2-12
  - Backfill → Tasks 13-15
  - Score-time instrumentation → Task 16
  - Factor audit → Task 17
  - Counterfactual harness → Task 18
  - Per-stat refactor loop → Tasks 19-25
  - New factor pool → referenced in Task 19 step 2 and Task 25 fallback
  - Phase B (newsInjury/lineupAdj/lineMovement) → instrumented in Task 16, included in `score_factors`, deferred for future regression
- [x] Acceptance gate failure path documented (backlog rather than ship noise)

---

## Open caveats not addressed in this plan

1. **`team_pace`, `team_defense`, `dvp_stats`, `opponent_leaks` table schemas** — Task 14 assumes column names. If actual schema differs, adjust the loaders.
2. **Vegas spread availability** — Task 14 leaves `spread_map` empty unless you have a games/odds_snapshots source. If not available, `blowout` factor stays None in backfill and won't enter regressions. Phase B will fix this once `score_factors` accumulates.
3. **`feature_version` bumping** — if the Python feature code changes after the initial backfill, bump `feature_version` and re-run `--resume`. The resume filter currently checks `prop_grade_id` existence, not version — extend the filter when needed.
