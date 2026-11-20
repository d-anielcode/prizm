# Kalshi NBA Prop Edge Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only CLI that compares Prizm's model probability against Kalshi NBA player-prop ask prices and prints a ranked edge table.

**Architecture:** A self-contained Python package `scripts/kalshi_edges/` with four focused modules: a no-auth Kalshi market reader, a Supabase/calibration reader, a pure probability engine (the calibrated mean-shift bridge), and a CLI orchestrator that joins the two sources. The engine fits a per-player distribution to game logs, anchors its mean to Prizm's calibrated P(over) at the sportsbook line, then extrapolates P(X≥K) at Kalshi's milestone strike.

**Tech Stack:** Python 3.14 (`python3`), `scipy` (distributions + `brentq` root-find), `requests`, `pytest`. Tests run from `scripts/` (its `tests/conftest.py` puts `scripts/` on `sys.path`).

**Spec:** `docs/superpowers/specs/2026-06-08-kalshi-edge-finder-design.md`

---

## File Structure

- Create: `scripts/kalshi_edges/__init__.py` — package marker (empty).
- Create: `scripts/kalshi_edges/prob_model.py` — pure probability engine (no I/O).
- Create: `scripts/kalshi_edges/market_data.py` — Kalshi public REST reader + title parser.
- Create: `scripts/kalshi_edges/prizm_data.py` — Supabase reader + calibration loader.
- Create: `scripts/kalshi_edges/find_edges.py` — join + edge computation + CLI.
- Create: `scripts/tests/test_kalshi_prob_model.py` — engine tests.
- Create: `scripts/tests/test_kalshi_market_data.py` — parser tests.
- Create: `scripts/tests/test_kalshi_prizm_data.py` — calibration interpolation tests.
- Create: `scripts/tests/test_kalshi_find_edges.py` — join + end-to-end tests.
- Create: `scripts/tests/fixtures/kalshi_markets.py` — recorded/synthetic Kalshi `/markets` rows.
- Create: `scripts/kalshi_edges/README.md` — usage notes.

**Test command (always from the `scripts/` directory):**
```bash
cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -v
```

---

## Task 1: Package scaffold + stat-value extraction

**Files:**
- Create: `scripts/kalshi_edges/__init__.py`
- Create: `scripts/kalshi_edges/prob_model.py`
- Test: `scripts/tests/test_kalshi_prob_model.py`

- [ ] **Step 1: Create the empty package marker**

Create `scripts/kalshi_edges/__init__.py` with a single line:

```python
"""Kalshi NBA prop edge finder (read-only). See docs/superpowers/specs/2026-06-08-kalshi-edge-finder-design.md."""
```

- [ ] **Step 2: Write the failing test for `stat_values`**

Create `scripts/tests/test_kalshi_prob_model.py`:

```python
from kalshi_edges.prob_model import stat_values

def _log(minutes, **stats):
    base = {"minutes": minutes, "points": 0, "rebounds": 0, "assists": 0,
            "fg3m": 0, "blocks": 0, "steals": 0, "pra": 0}
    base.update(stats)
    return base

def test_stat_values_maps_three_pointers_to_fg3m():
    logs = [_log(30, fg3m=4), _log(28, fg3m=2)]
    assert stat_values(logs, "three_pointers") == [4.0, 2.0]

def test_stat_values_filters_low_minute_games():
    logs = [_log(30, points=20), _log(3, points=50)]
    assert stat_values(logs, "points") == [20.0]

def test_stat_values_skips_null_stat():
    logs = [_log(30, points=20), {"minutes": 30, "points": None}]
    assert stat_values(logs, "points") == [20.0]
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'kalshi_edges.prob_model'`.

- [ ] **Step 4: Write minimal implementation**

Create `scripts/kalshi_edges/prob_model.py`:

```python
"""Parametric P(stat >= strike) engine for the Kalshi edge finder.

Pure functions, no I/O. See the design spec for the calibrated mean-shift bridge.
"""
from __future__ import annotations
from dataclasses import dataclass

# Canonical stat_type -> player_game_logs column key.
STAT_LOG_KEY = {
    "points": "points", "rebounds": "rebounds", "assists": "assists",
    "pra": "pra", "steals": "steals", "blocks": "blocks",
    "three_pointers": "fg3m",
}
COUNT_STATS = {"rebounds", "assists", "three_pointers", "steals", "blocks"}
NORMAL_STATS = {"points", "pra"}
MIN_MINUTES = 5
MIN_GAMES = 10

def stat_values(logs, stat):
    """Per-game values for `stat`, dropping games under MIN_MINUTES or with a null value."""
    key = STAT_LOG_KEY[stat]
    out = []
    for g in logs:
        if (g.get("minutes") or 0) < MIN_MINUTES:
            continue
        v = g.get(key)
        if v is None:
            continue
        out.append(float(v))
    return out
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -v`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add scripts/kalshi_edges/__init__.py scripts/kalshi_edges/prob_model.py scripts/tests/test_kalshi_prob_model.py
git commit -m "feat(kalshi): stat_values extraction for prop edge engine"
```

---

## Task 2: Fit distribution from logs

**Files:**
- Modify: `scripts/kalshi_edges/prob_model.py`
- Test: `scripts/tests/test_kalshi_prob_model.py`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/test_kalshi_prob_model.py`:

```python
import pytest
from kalshi_edges.prob_model import fit_distribution, Distribution

def _logs(values, stat_key="points", minutes=30):
    return [{"minutes": minutes, stat_key: v} for v in values]

def test_fit_normal_for_points():
    d = fit_distribution(_logs([20, 22, 18, 24, 26, 19, 21, 23, 25, 17]), "points")
    assert d.family == "normal"
    assert d.mu0 == pytest.approx(21.5, abs=0.01)
    assert d.sigma > 0

def test_fit_nbinom_for_overdispersed_count():
    # rebounds with variance > mean -> negative binomial
    vals = [2, 8, 1, 12, 3, 9, 0, 14, 4, 11]
    d = fit_distribution(_logs(vals, "rebounds"), "rebounds")
    assert d.family == "nbinom"
    assert d.r is not None and d.r > 0

def test_fit_poisson_when_not_overdispersed():
    # near-constant count -> variance <= mean -> poisson fallback
    vals = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]
    d = fit_distribution(_logs(vals, "assists"), "assists")
    assert d.family == "poisson"

def test_fit_raises_on_thin_sample():
    with pytest.raises(ValueError):
        fit_distribution(_logs([20, 22, 18]), "points")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -k fit -v`
Expected: FAIL — `cannot import name 'fit_distribution'`.

- [ ] **Step 3: Implement**

Add to `scripts/kalshi_edges/prob_model.py` (after `stat_values`):

```python
import math
from statistics import mean, pvariance

@dataclass
class Distribution:
    family: str          # "normal" | "nbinom" | "poisson"
    mu0: float           # baseline mean from logs
    sigma: float         # std (used by normal; informational for counts)
    r: float | None      # negative-binomial size param (None otherwise)

def fit_distribution(logs, stat):
    """Fit a stat distribution to game logs via method-of-moments.

    Raises ValueError when fewer than MIN_GAMES qualifying games exist.
    """
    vals = stat_values(logs, stat)
    if len(vals) < MIN_GAMES:
        raise ValueError(f"insufficient games: {len(vals)} < {MIN_GAMES}")
    mu0 = mean(vals)
    var = pvariance(vals) if len(vals) > 1 else mu0
    if stat in NORMAL_STATS:
        return Distribution("normal", mu0, max(math.sqrt(var), 1e-6), None)
    # counting stat
    if mu0 <= 0 or var <= mu0:               # degenerate or not overdispersed
        m = max(mu0, 1e-6)
        return Distribution("poisson", m, math.sqrt(m), None)
    r = mu0 * mu0 / (var - mu0)              # NB size from moments
    return Distribution("nbinom", mu0, math.sqrt(var), r)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/prob_model.py scripts/tests/test_kalshi_prob_model.py
git commit -m "feat(kalshi): fit_distribution (normal/nbinom/poisson) from logs"
```

---

## Task 3: Probability at strike + calibrated mean-shift solver

**Files:**
- Modify: `scripts/kalshi_edges/prob_model.py`
- Test: `scripts/tests/test_kalshi_prob_model.py`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/tests/test_kalshi_prob_model.py`:

```python
from kalshi_edges.prob_model import prob_over_line, prob_at_strike, solve_shift

def _normal(mu=20.0, sigma=5.0):
    return Distribution("normal", mu, sigma, None)

def test_prob_over_line_normal_half_point():
    # P(X > 20) for N(20,5) ~ 0.5 (continuity not applied to .5 lines)
    assert prob_over_line(_normal(), 20.0, 20.0) == pytest.approx(0.5, abs=1e-6)

def test_prob_at_strike_monotonic_in_strike():
    d = _normal(25, 6)
    p25 = prob_at_strike(d, 0.0, 25)
    p30 = prob_at_strike(d, 0.0, 30)
    assert p30 < p25

def test_solve_shift_round_trip():
    d = _normal(20, 5)
    true_delta = 3.0
    target = prob_over_line(d, d.mu0 + true_delta, 22.5)
    delta, clamped = solve_shift(d, 22.5, target)
    assert not clamped
    assert delta == pytest.approx(true_delta, abs=0.05)

def test_solve_shift_higher_target_gives_higher_delta():
    d = _normal(20, 5)
    lo, _ = solve_shift(d, 20.5, 0.45)
    hi, _ = solve_shift(d, 20.5, 0.65)
    assert hi > lo

def test_solve_shift_clamps_unreachable_target():
    d = _normal(20, 5)
    delta, clamped = solve_shift(d, 20.5, 0.999999)
    assert clamped is True

def test_prob_at_strike_nbinom_discrete():
    # mean 6, overdispersed; P(X>=6) should be a sensible (0,1) value
    d = Distribution("nbinom", 6.0, 3.0, 4.0)
    p = prob_at_strike(d, 0.0, 6)
    assert 0.0 < p < 1.0
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -k "prob_ or solve_shift" -v`
Expected: FAIL — `cannot import name 'prob_over_line'`.

- [ ] **Step 3: Implement**

Add to `scripts/kalshi_edges/prob_model.py`:

```python
from scipy import stats
from scipy.optimize import brentq

def _sf_at(dist, mu, x):
    """P(X > x) for `dist` shifted to mean `mu`. x may be fractional."""
    if dist.family == "normal":
        # Continuity correction only for integer thresholds; book .5 lines need none.
        bump = 0.5 if float(x).is_integer() else 0.0
        return float(stats.norm.sf((x + bump - mu) / dist.sigma))
    if dist.family == "poisson":
        return float(stats.poisson.sf(math.floor(x), max(mu, 1e-9)))
    # negative binomial: hold size r fixed, recompute p for the shifted mean
    r = dist.r
    p = r / (r + max(mu, 1e-9))
    return float(stats.nbinom.sf(math.floor(x), r, p))

def prob_over_line(dist, mu, line):
    """P(X > line) at mean `mu`. For sportsbook .5 lines this is unambiguous."""
    return _sf_at(dist, mu, line)

def prob_at_strike(dist, delta, strike):
    """P(X >= strike) at shifted mean mu0+delta. `strike` is an integer milestone."""
    # P(X >= K) == P(X > K-1)
    return _sf_at(dist, dist.mu0 + delta, strike - 1)

def solve_shift(dist, book_line, target_p, max_shift=None):
    """Find delta so P(X > book_line | mu0+delta) == target_p.

    Returns (delta, clamped). Clamps to the search bound (and flags it) when the
    target probability is unreachable within +/- max_shift.
    """
    if max_shift is None:
        max_shift = 4.0 * dist.sigma
    target_p = min(max(target_p, 1e-6), 1 - 1e-6)
    f = lambda d: prob_over_line(dist, dist.mu0 + d, book_line) - target_p
    lo, hi = -max_shift, max_shift
    flo, fhi = f(lo), f(hi)
    if flo == 0.0:
        return (lo, False)
    if fhi == 0.0:
        return (hi, False)
    if (flo > 0) == (fhi > 0):                 # no sign change -> unreachable
        return (hi, True) if abs(fhi) < abs(flo) else (lo, True)
    return (float(brentq(f, lo, hi, xtol=1e-4)), False)
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prob_model.py -v`
Expected: PASS (13 passed).

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/prob_model.py scripts/tests/test_kalshi_prob_model.py
git commit -m "feat(kalshi): prob_at_strike + calibrated mean-shift solver"
```

---

## Task 4: Kalshi market reader + title parser

**Files:**
- Create: `scripts/kalshi_edges/market_data.py`
- Create: `scripts/tests/fixtures/kalshi_markets.py`
- Test: `scripts/tests/test_kalshi_market_data.py`

- [ ] **Step 1: Create the fixture**

Create `scripts/tests/fixtures/kalshi_markets.py` (synthetic rows matching Kalshi's `/markets` schema; `yes_bid`/`yes_ask` are integer cents 0–100):

```python
"""Synthetic Kalshi /markets rows for parser tests.

Mirrors the documented Kalshi market schema. Task 8 reconciles the title format
against a live response and adjusts market_data constants if needed.
"""
def sample_markets():
    return [
        {"ticker": "KXNBAPTS-LBJ-30", "title": "LeBron James to score 30+ points",
         "subtitle": "", "yes_bid": 38, "yes_ask": 42, "volume": 1200, "status": "open"},
        {"ticker": "KXNBAREB-NJ-15", "title": "Will Nikola Jokic record 15+ rebounds?",
         "subtitle": "", "yes_bid": 28, "yes_ask": 33, "volume": 800, "status": "open"},
        {"ticker": "KXNBA3PM-SC-5", "title": "Stephen Curry to make 5+ three-pointers",
         "subtitle": "", "yes_bid": 45, "yes_ask": 49, "volume": 1500, "status": "open"},
        {"ticker": "KXECON-CPI", "title": "CPI above 3% in June",
         "subtitle": "", "yes_bid": 50, "yes_ask": 55, "volume": 999, "status": "open"},
    ]
```

- [ ] **Step 2: Write the failing tests**

Create `scripts/tests/test_kalshi_market_data.py`:

```python
from kalshi_edges.market_data import parse_market, KalshiProp
from tests.fixtures.kalshi_markets import sample_markets

def test_parse_points_market():
    kp = parse_market(sample_markets()[0])
    assert kp == KalshiProp("KXNBAPTS-LBJ-30", "LeBron James", "points", 30, 0.38, 0.42, 1200)

def test_parse_rebounds_strips_will_and_question():
    kp = parse_market(sample_markets()[1])
    assert kp.player == "Nikola Jokic"
    assert kp.stat == "rebounds"
    assert kp.strike == 15

def test_parse_three_pointers():
    kp = parse_market(sample_markets()[2])
    assert kp.stat == "three_pointers"
    assert kp.strike == 5
    assert kp.yes_ask == 0.49

def test_parse_non_prop_returns_none():
    assert parse_market(sample_markets()[3]) is None
```

- [ ] **Step 3: Run to verify failure**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_market_data.py -v`
Expected: FAIL — `No module named 'kalshi_edges.market_data'`.

- [ ] **Step 4: Implement**

Create `scripts/kalshi_edges/market_data.py`:

```python
"""Kalshi public market-data reader + prop-title parser. No auth required for reads."""
import re
import requests
from dataclasses import dataclass

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

# Order matters: 'point' is generic, so it is checked last. PRA before points.
STAT_KEYWORDS = [
    ("three_pointers", ("three-pointer", "three pointer", "3-pointer", "threes", "3pm")),
    ("rebounds", ("rebound",)),
    ("assists", ("assist",)),
    ("steals", ("steal",)),
    ("blocks", ("block",)),
    ("pra", ("points + rebounds + assists", "pts+reb+ast", "pra")),
    ("points", ("point",)),
]
STRIKE_RE = re.compile(r"(\d+)\s*\+")
_CUE_RE = re.compile(r"\b(to record|to score|to make|to grab|record|score|make|grab|dish|with)\b", re.I)

@dataclass
class KalshiProp:
    ticker: str
    player: str
    stat: str
    strike: int
    yes_bid: float   # 0..1
    yes_ask: float   # 0..1
    volume: int

def _classify_stat(text):
    t = text.lower()
    for stat, kws in STAT_KEYWORDS:
        if any(k in t for k in kws):
            return stat
    return None

def _extract_player(title):
    t = re.sub(r"^\s*will\s+", "", title, flags=re.I).strip()
    m = _CUE_RE.search(t)
    name = (t[:m.start()] if m else t).strip(" ?:-")
    return name if len(name.split()) >= 2 else None

def _cents(v):
    return None if v is None else float(v) / 100.0

def parse_market(raw):
    """Parse one Kalshi market dict into a KalshiProp, or None if not an NBA prop."""
    text = f"{raw.get('title') or ''} {raw.get('subtitle') or ''}"
    stat = _classify_stat(text)
    if stat is None:
        return None
    m = STRIKE_RE.search(text)
    if not m:
        return None
    player = _extract_player(raw.get("title") or "")
    if not player:
        return None
    ask = _cents(raw.get("yes_ask"))
    if ask is None:
        return None
    return KalshiProp(raw.get("ticker", ""), player, stat, int(m.group(1)),
                      _cents(raw.get("yes_bid")) or 0.0, ask, int(raw.get("volume") or 0))

def fetch_markets(limit_pages=10, session=None):
    """Page through open Kalshi markets. Returns raw market dicts."""
    sess = session or requests.Session()
    out, cursor = [], None
    for _ in range(limit_pages):
        params = {"limit": 1000, "status": "open"}
        if cursor:
            params["cursor"] = cursor
        r = sess.get(f"{KALSHI_BASE}/markets", params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        out.extend(data.get("markets", []))
        cursor = data.get("cursor")
        if not cursor:
            break
    return out

def fetch_props(session=None):
    """Convenience: fetch + parse, dropping non-props."""
    return [kp for raw in fetch_markets(session=session) if (kp := parse_market(raw))]
```

- [ ] **Step 5: Run to verify pass**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_market_data.py -v`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```bash
git add scripts/kalshi_edges/market_data.py scripts/tests/test_kalshi_market_data.py scripts/tests/fixtures/kalshi_markets.py
git commit -m "feat(kalshi): market reader + prop-title parser"
```

---

## Task 5: Prizm data reader + calibration interpolation

**Files:**
- Create: `scripts/kalshi_edges/prizm_data.py`
- Test: `scripts/tests/test_kalshi_prizm_data.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/test_kalshi_prizm_data.py`:

```python
import pytest
from kalshi_edges.prizm_data import apply_calibration

def _table():
    # 101-length arrays of percent values; per_stat overrides global.
    return {
        "lookup": [float(i) for i in range(101)],            # global: score==percent
        "per_stat": {"points": [50.0] * 101},                # points: flat 50%
    }

def test_apply_calibration_uses_per_stat():
    assert apply_calibration(_table(), "points", 80) == pytest.approx(0.50)

def test_apply_calibration_falls_back_to_global():
    # rebounds not in per_stat -> use global lookup (score 80 -> 80%)
    assert apply_calibration(_table(), "rebounds", 80) == pytest.approx(0.80)

def test_apply_calibration_interpolates_fractional_score():
    # global lookup at 80.5 -> 80.5%
    assert apply_calibration(_table(), "rebounds", 80.5) == pytest.approx(0.805)

def test_apply_calibration_clamps_out_of_range():
    assert apply_calibration(_table(), "rebounds", 150) == pytest.approx(1.0)
    assert apply_calibration(_table(), "rebounds", -10) == pytest.approx(0.0)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prizm_data.py -v`
Expected: FAIL — `No module named 'kalshi_edges.prizm_data'`.

- [ ] **Step 3: Implement**

Create `scripts/kalshi_edges/prizm_data.py`:

```python
"""Supabase reader + calibration loader for the Kalshi edge finder.

Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY from the environment
(source .env.local before running the CLI).
"""
import os
import json
import math
import requests

SB_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

def _sb_get(table, params=""):
    rows, offset = [], 0
    while True:
        sep = "&" if params else ""
        url = f"{SB_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}"
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows

def todays_props(game_date):
    """Scored props for a given game_date (YYYY-MM-DD)."""
    return _sb_get(
        "props",
        f"select=player_name,stat_type,direction,line,confidence_score,game_date"
        f"&game_date=eq.{game_date}&confidence_score=not.is.null",
    )

def all_logs():
    """All player game logs, most recent first."""
    return _sb_get("player_game_logs", "order=game_date.desc")

def load_calibration(path="lib/calibration-table.json"):
    with open(path) as f:
        return json.load(f)

def apply_calibration(table, stat, score):
    """Map a confidence score (0-100) to P(prop hits), in [0,1].

    Mirrors lib/calibration.ts: per-stat lookup preferred, global as fallback,
    linear interpolation between integer scores. Table values are percents.
    """
    arr = (table.get("per_stat") or {}).get(stat) or table["lookup"]
    s = min(max(float(score), 0.0), 100.0)
    lo = int(math.floor(s))
    hi = min(lo + 1, len(arr) - 1)
    frac = s - lo
    pct = arr[lo] * (1 - frac) + arr[hi] * frac
    return pct / 100.0
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_prizm_data.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/prizm_data.py scripts/tests/test_kalshi_prizm_data.py
git commit -m "feat(kalshi): Supabase reader + calibration interpolation"
```

---

## Task 6: Join + edge computation + CLI

**Files:**
- Create: `scripts/kalshi_edges/find_edges.py`
- Test: `scripts/tests/test_kalshi_find_edges.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/test_kalshi_find_edges.py`:

```python
import pytest
from kalshi_edges.market_data import KalshiProp
from kalshi_edges.find_edges import normalize_name, build_prop_index, compute_edge, find_edges

def _calib():
    return {"lookup": [float(i) for i in range(101)], "per_stat": {}}

def _logs(values, key="points", minutes=30):
    return [{"minutes": minutes, key: v} for v in values]

def test_normalize_name_strips_accents_and_suffix():
    assert normalize_name("Luka Dončić") == "luka doncic"
    assert normalize_name("Jaren Jackson Jr.") == "jaren jackson"

def test_build_prop_index_flags_ambiguous_collision():
    props = [
        {"player_name": "John Smith", "stat_type": "points", "direction": "over",
         "line": 20.5, "confidence_score": 70},
        {"player_name": "John  Smith", "stat_type": "points", "direction": "under",
         "line": 19.5, "confidence_score": 60},
    ]
    index, ambiguous = build_prop_index(props)
    assert ("john smith", "points") in ambiguous

def test_compute_edge_unfactored_when_no_prop():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    e = compute_edge(kp, None, _logs([26] * 12), _calib())
    assert e is not None
    assert e.flag == "unfactored"
    assert e.model_p > 0.5            # logs center above 25 -> likely over

def test_compute_edge_returns_none_on_thin_logs():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    assert compute_edge(kp, None, _logs([26, 26, 26]), _calib()) is None

def test_compute_edge_factored_direction_under():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    prop = {"player_name": "LeBron James", "stat_type": "points", "direction": "under",
            "line": 24.5, "confidence_score": 80}
    # Logs with real spread (mean ~25, sigma ~5) so the mean shift can actually move.
    e = compute_edge(kp, prop, _logs([20, 30, 25, 18, 32, 22, 28, 24, 26, 21,
                                      29, 23, 27, 19, 31]), _calib())
    # under@80 -> p_hit .80 -> p_over .20 -> mean shifts DOWN -> low P(>=25)
    assert e.flag in ("factored", "clamped")
    assert e.model_p < 0.5

def test_find_edges_filters_and_sorts():
    # Zero-variance logs at 28 -> model_p == 1.0 for strike 20, so edge == 1 - ask.
    kps = [
        KalshiProp("A", "Big Edge", "points", 20, 0.30, 0.35, 1000),  # edge +0.65 keep
        KalshiProp("B", "Tiny Edge", "points", 20, 0.30, 0.98, 1000), # edge +0.02 drop
        KalshiProp("C", "Low Vol", "points", 20, 0.30, 0.35, 5),      # vol < 100 drop
    ]
    logs_by_player = {
        "big edge": _logs([28] * 15), "tiny edge": _logs([28] * 15),
        "low vol": _logs([28] * 15),
    }
    edges = find_edges(kps, {}, set(), logs_by_player, _calib(),
                       min_edge=0.05, min_volume=100)
    assert [e.player for e in edges] == ["Big Edge"]   # Tiny Edge < min_edge, Low Vol < min_volume
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_find_edges.py -v`
Expected: FAIL — `No module named 'kalshi_edges.find_edges'`.

- [ ] **Step 3: Implement**

Create `scripts/kalshi_edges/find_edges.py`:

```python
"""Join Kalshi prop markets to Prizm props, compute edges, print + dump a report."""
import argparse
import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import date

from kalshi_edges import market_data, prizm_data, prob_model

def normalize_name(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", s)
    s = re.sub(r"[^a-z ]", "", s)
    return re.sub(r"\s+", " ", s).strip()

def build_prop_index(props):
    """Return (index, ambiguous_keys). A key is ambiguous if two different raw
    player names normalize to the same (name, stat) pair."""
    index, raw_seen, ambiguous = {}, defaultdict(set), set()
    for p in props:
        key = (normalize_name(p["player_name"]), p["stat_type"])
        raw_seen[key].add(p["player_name"].strip())
        index[key] = p
    for key, names in raw_seen.items():
        if len(names) > 1:
            ambiguous.add(key)
    return index, ambiguous

@dataclass
class Edge:
    player: str
    stat: str
    strike: int
    model_p: float
    yes_ask: float
    edge: float
    volume: int
    flag: str

def compute_edge(kp, prop, logs, calib, ambiguous=False):
    try:
        dist = prob_model.fit_distribution(logs, kp.stat)
    except ValueError:
        return None
    flags = []
    delta = 0.0
    if prop is not None and not ambiguous:
        p_hit = prizm_data.apply_calibration(calib, kp.stat, prop["confidence_score"])
        p_over = p_hit if prop["direction"] == "over" else 1.0 - p_hit
        delta, clamped = prob_model.solve_shift(dist, float(prop["line"]), p_over)
        flags.append("clamped" if clamped else "factored")
    else:
        flags.append("ambiguous" if ambiguous else "unfactored")
    model_p = prob_model.prob_at_strike(dist, delta, kp.strike)
    return Edge(kp.player, kp.stat, kp.strike, round(model_p, 4),
                kp.yes_ask, round(model_p - kp.yes_ask, 4), kp.volume, "+".join(flags))

def find_edges(kalshi_props, prop_index, ambiguous_keys, logs_by_player, calib,
               min_edge=0.0, min_volume=0):
    edges = []
    for kp in kalshi_props:
        nname = normalize_name(kp.player)
        key = (nname, kp.stat)
        e = compute_edge(kp, prop_index.get(key), logs_by_player.get(nname, []),
                         calib, ambiguous=(key in ambiguous_keys))
        if e is None or e.volume < min_volume or abs(e.edge) < min_edge:
            continue
        edges.append(e)
    edges.sort(key=lambda e: e.edge, reverse=True)
    return edges

def _group_logs(logs):
    by_player = defaultdict(list)
    for g in logs:
        by_player[normalize_name(g["player_name"])].append(g)
    return by_player

def main():
    ap = argparse.ArgumentParser(description="Kalshi NBA prop edge finder (read-only)")
    ap.add_argument("--game-date", default=date.today().isoformat())
    ap.add_argument("--min-edge", type=float, default=0.03)
    ap.add_argument("--min-volume", type=int, default=0)
    ap.add_argument("--stat", default=None, help="filter to one stat_type")
    ap.add_argument("--calibration", default="lib/calibration-table.json")
    args = ap.parse_args()

    kalshi = market_data.fetch_props()
    if args.stat:
        kalshi = [k for k in kalshi if k.stat == args.stat]
    props = prizm_data.todays_props(args.game_date)
    if not props:
        print(f"WARNING: no scored props for {args.game_date}; all edges will be unfactored.")
    index, ambiguous = build_prop_index(props)
    logs_by_player = _group_logs(prizm_data.all_logs())
    calib = prizm_data.load_calibration(args.calibration)

    edges = find_edges(kalshi, index, ambiguous, logs_by_player, calib,
                       args.min_edge, args.min_volume)

    print(f"\n{'PLAYER':<22} {'STAT':<14} {'K':>3} {'MODEL':>6} {'ASK':>6} {'EDGE':>7} {'VOL':>6}  FLAG")
    print("-" * 80)
    for e in edges:
        print(f"{e.player:<22} {e.stat:<14} {e.strike:>3} {e.model_p:>6.2f} "
              f"{e.yes_ask:>6.2f} {e.edge:>+7.2f} {e.volume:>6}  {e.flag}")
    print(f"\n{len(edges)} edges (min_edge={args.min_edge}, min_volume={args.min_volume})")

    out = f"kalshi_edges_{args.game_date}.json"
    with open(out, "w") as f:
        json.dump([asdict(e) for e in edges], f, indent=2)
    print(f"Written to {out}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify pass**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_find_edges.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Run the full Kalshi suite**

Run: `cd scripts && python3 -m pytest tests/test_kalshi_*.py -v`
Expected: PASS (27 passed).

- [ ] **Step 6: Commit**

```bash
git add scripts/kalshi_edges/find_edges.py scripts/tests/test_kalshi_find_edges.py
git commit -m "feat(kalshi): join + edge computation + CLI"
```

---

## Task 7: Live smoke verification + parser reconciliation

**Files:**
- Modify (only if needed): `scripts/kalshi_edges/market_data.py`

This task validates the one assumption tests cannot: Kalshi's real prop-title format. No new automated test; it is a manual verification step.

- [ ] **Step 1: Fetch a live sample of Kalshi markets and inspect titles**

Run:
```bash
cd scripts && python3 -c "
from kalshi_edges import market_data as m
raw = m.fetch_markets(limit_pages=2)
parsed = [m.parse_market(r) for r in raw]
parsed = [p for p in parsed if p]
print('raw markets:', len(raw), '| parsed props:', len(parsed))
for p in parsed[:10]: print(p)
"
```
Expected: prints a count of raw markets and any parsed props.

- [ ] **Step 2: Reconcile the parser if zero props parsed**

If `parsed props: 0` but `raw markets` is non-zero, print a few NBA-looking titles to see the real format:
```bash
cd scripts && python3 -c "
from kalshi_edges import market_data as m
for r in m.fetch_markets(limit_pages=2):
    t = (r.get('title') or '')
    if any(w in t.lower() for w in ('point','rebound','assist','three','block','steal')):
        print(repr(t), '| yes_ask=', r.get('yes_ask'))
" | head -20
```
Then, if the real titles differ from the fixture assumption, update `STAT_KEYWORDS`, `STRIKE_RE`, or `_CUE_RE` / `_extract_player` in `market_data.py` to match, and re-run the Task 4 tests:
`cd scripts && python3 -m pytest tests/test_kalshi_market_data.py -v` (must stay green — update the fixture too if the real schema differs, keeping tests deterministic).

- [ ] **Step 3: End-to-end dry run against live data**

Run (sourcing Supabase creds):
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && cd scripts && python3 -m kalshi_edges.find_edges --min-edge 0.0
```
Expected: prints the edge table (possibly empty if no NBA slate today) and writes `scripts/kalshi_edges_<date>.json` without error.

- [ ] **Step 4: Commit any parser adjustments**

```bash
git add scripts/kalshi_edges/market_data.py scripts/tests/fixtures/kalshi_markets.py scripts/tests/test_kalshi_market_data.py
git commit -m "fix(kalshi): reconcile prop-title parser with live Kalshi format"
```
(If no changes were needed, skip the commit.)

---

## Task 8: Usage README

**Files:**
- Create: `scripts/kalshi_edges/README.md`

- [ ] **Step 1: Write the README**

Create `scripts/kalshi_edges/README.md`:

```markdown
# Kalshi NBA Prop Edge Finder (read-only)

Compares Prizm's model probability against Kalshi NBA player-prop ask prices and
prints a ranked edge table. No auth, no orders. See the design spec at
`docs/superpowers/specs/2026-06-08-kalshi-edge-finder-design.md`.

## Run

    cd /c/Users/dcho0/nbaiqproject
    set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a
    cd scripts
    python3 -m kalshi_edges.find_edges --min-edge 0.03 --min-volume 50

## Flags

- `--game-date YYYY-MM-DD`  which day's scored props to anchor against (default: today)
- `--min-edge`              minimum |model_p - yes_ask| to display (default: 0.03)
- `--min-volume`            minimum Kalshi contract volume (default: 0)
- `--stat`                  restrict to one stat_type (e.g. `points`)

## How it works

1. Fit a per-player distribution (negative binomial for counts, normal for
   points/PRA) to `player_game_logs`.
2. Anchor its mean to Prizm's calibrated P(over) at the sportsbook line
   (the `props` table's `confidence_score` -> `lib/calibration-table.json`).
3. Evaluate P(X >= strike) at Kalshi's milestone strike.
4. Edge = model probability - Kalshi yes_ask.

## Output flags

- `factored`    anchored to a matching Prizm prop (full confidence-score coupling)
- `unfactored`  no matching Prizm prop; pure log-based distribution
- `clamped`     the score implied a probability unreachable by the mean shift
- `ambiguous`   multiple raw names normalized to the same player; excluded from anchoring
```

- [ ] **Step 2: Commit**

```bash
git add scripts/kalshi_edges/README.md
git commit -m "docs(kalshi): usage README for the edge finder"
```

---

## Self-Review notes

- **Spec coverage:** market reader (Task 4), Supabase+calibration reader (Task 5), prob engine with the calibrated mean-shift bridge incl. direction handling (Tasks 1–3, 6), join with normalization + ambiguity (Task 6), error handling — thin logs / no match / clamp / ambiguous / stale props (Tasks 3, 6), testing incl. fixture-based parser test and end-to-end (Tasks 4, 6), live reconciliation of the title-format assumption (Task 7). All spec sections map to a task.
- **Out of scope (per spec):** no RSA auth, no orders, no paper-trade logging, no scheduled job, no parlay construction. Not present in any task.
- **`scipy`/`requests`/`pytest`** already installed on `python3` (3.14) — no install task needed.
```
