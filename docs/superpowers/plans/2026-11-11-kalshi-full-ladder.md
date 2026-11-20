# Kalshi Full-Ladder Model Picks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price every Kalshi points/rebounds/assists/threes/PRA rung from the sportsbook model (stretched via a per-player distribution), log and grade those "stretched" picks as paper, and replay the method on 2025-26 against a pre-registered bar.

**Architecture:** One pure Python module (`scripts/kalshi_edges/ladder_model.py`) turns a player's scored sportsbook lines + game logs into P(X >= N) for each Kalshi strike, reusing the June mean-shift bridge in `prob_model.py`. A `kalshi_live` pipeline step writes those probabilities to a new `kalshi_model_rungs` table; the TS model-picks code reads it, picks stretched rungs with the same filters as exact picks, and logs them with `kind = 'stretched'`. A separate replay module + script runs the same bridge on 2025-26 settled rungs and writes a report.

**Tech Stack:** Python 3 + scipy + pytest (scripts/), Next.js 16 App Router + TypeScript + vitest, Supabase PostgREST (service role in scripts, anon in pages).

**Spec:** `docs/superpowers/specs/2026-11-11-kalshi-full-ladder-design.md`

**Repo:** `C:\Users\dcho0\nbaiqproject`. Work on a branch: `git checkout -b feat/kalshi-full-ladder` from `master` before Task 1.

**Commands:**
- Python tests: `cd scripts && python -m pytest tests -q`
- TS tests: `npx vitest run`
- Types: `npx tsc --noEmit`
- Lint: `npx eslint .`

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20261112120000_kalshi_model_rungs.sql` | create | `kalshi_model_rungs` table; `kind` column on `kalshi_model_picks` |
| `scripts/kalshi_edges/ladder_model.py` | create | pure bridge: anchor, prior logs, ladder probabilities, rung rows, ET window |
| `scripts/tests/test_kalshi_ladder_model.py` | create | tests for the above |
| `scripts/kalshi_model_rungs.py` | create | live pipeline step: read today's data, write `kalshi_model_rungs` |
| `scripts/pipeline/phases.py` | modify | add `kalshi_model_rungs` to `kalshi_live` |
| `scripts/tests/test_pipeline_phases.py` | modify | phase expectations |
| `lib/kalshi/model-picks.ts` | modify | `kind`, `STRETCH` tier, `matchStretched`, `visiblePicks`, `STRETCHED_VISIBLE`, `toLogRow` kind |
| `lib/__tests__/kalshi-model-picks.test.ts` | modify | tests for the above |
| `lib/kalshi/model-picks-data.ts` | modify | load rungs; return exact/stretched/visible; `kind` on logged rows |
| `app/api/markets/model-picks/log/route.ts` | modify | log both kinds |
| `components/ModelPicks.tsx` | modify | `STRETCH` badge style |
| `app/markets/page.tsx`, `app/markets/feed/page.tsx` | modify | show `visible` picks; Home record over visible kinds |
| `app/markets/performance/page.tsx` | modify | "By kind" table |
| `scripts/kalshi_edges/ladder_replay.py` | create | pure replay: trades, bar verdict, Brier, calibration, report |
| `scripts/tests/test_kalshi_ladder_replay.py` | create | tests for the above |
| `scripts/kalshi_ladder_replay.py` | create | replay entry script (PC, run once) |

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261112120000_kalshi_model_rungs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Full-ladder Kalshi model picks (spec 2026-11-11).
-- kalshi_model_rungs: one row per Kalshi ticker, the sportsbook model stretched to that strike.
-- Written every 15 min by scripts/kalshi_model_rungs.py (service role); read by /markets pages.
-- New tables on this project get no API grants by default, so grants are explicit.
CREATE TABLE IF NOT EXISTS kalshi_model_rungs (
  ticker         text PRIMARY KEY,
  player         text NOT NULL,
  stat           text NOT NULL,
  strike         int  NOT NULL,
  game_date      date NOT NULL,
  model_p        numeric NOT NULL,       -- P(stat >= strike)
  anchor_line    numeric NOT NULL,
  anchor_p       numeric NOT NULL,       -- calibrated P(over anchor_line)
  delta          numeric NOT NULL,       -- mean shift applied to the log distribution
  exact          boolean NOT NULL,       -- a scored book line sits at strike - 0.5
  commence_time  timestamptz,
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kalshi_model_rungs_game_date_idx ON kalshi_model_rungs (game_date);
GRANT SELECT, INSERT, UPDATE, DELETE ON kalshi_model_rungs TO service_role;
GRANT SELECT ON kalshi_model_rungs TO anon, authenticated;
ALTER TABLE kalshi_model_rungs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read" ON kalshi_model_rungs;
CREATE POLICY "anon_read" ON kalshi_model_rungs FOR SELECT TO anon, authenticated USING (true);

-- Exact-line picks vs stretched picks share one ledger.
ALTER TABLE kalshi_model_picks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'exact';
```

- [ ] **Step 2: Apply it**

Apply with the Supabase MCP `apply_migration` (project `shvoyqofsbtnzwokuutt`, name `kalshi_model_rungs`), then verify:

```sql
select count(*) from kalshi_model_rungs;
select kind, count(*) from kalshi_model_picks group by 1;
```
Expected: `0`; every existing pick has `kind = 'exact'`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261112120000_kalshi_model_rungs.sql
git commit -m "feat(db): kalshi_model_rungs table and kind on kalshi_model_picks"
```

---

### Task 2: Bridge — anchor and prior logs

**Files:**
- Create: `scripts/kalshi_edges/ladder_model.py`
- Test: `scripts/tests/test_kalshi_ladder_model.py`

- [ ] **Step 1: Write the failing tests**

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from kalshi_edges.ladder_model import anchor, prior_logs

# Identity-ish calibration: per-stat lookup where score s -> s percent.
CAL = {"lookup": [float(i) for i in range(101)], "per_stat": {}}

def sc(line, direction, score):
    return {"line": line, "direction": direction, "confidence_score": score}

def test_anchor_averages_both_sides():
    # over 60 -> 0.60, under 30 -> P(over) 0.70; mean 0.65
    line, p = anchor([sc(24.5, "over", 60), sc(24.5, "under", 30)], "points", CAL)
    assert line == 24.5 and abs(p - 0.65) < 1e-9

def test_anchor_prefers_two_sided_line_over_closer_one_sided():
    rows = [sc(24.5, "over", 80), sc(24.5, "under", 30),   # two-sided, P(over)=0.75
            sc(29.5, "over", 50)]                           # one-sided, exactly 0.5
    assert anchor(rows, "points", CAL)[0] == 24.5

def test_anchor_two_sided_tie_break_closest_to_half():
    rows = [sc(19.5, "over", 80), sc(19.5, "under", 20),   # 0.80
            sc(24.5, "over", 55), sc(24.5, "under", 45)]   # 0.55
    assert anchor(rows, "points", CAL)[0] == 24.5

def test_anchor_under_only_line():
    line, p = anchor([sc(6.5, "under", 70)], "rebounds", CAL)
    assert line == 6.5 and abs(p - 0.30) < 1e-9

def test_anchor_averages_duplicate_books():
    line, p = anchor([sc(24.5, "over", 60), sc(24.5, "over", 70)], "points", CAL)
    assert abs(p - 0.65) < 1e-9

def test_anchor_none_without_usable_rows():
    assert anchor([], "points", CAL) is None
    assert anchor([sc(24.5, "over", None), sc(24.5, "push", 50)], "points", CAL) is None

def test_prior_logs_strictly_before_and_newest_first():
    logs = [{"game_date": d} for d in ["2026-01-03", "2026-01-01", "2026-01-05", "2026-01-02"]]
    out = prior_logs(logs, "2026-01-03", n=2)
    assert [g["game_date"] for g in out] == ["2026-01-02", "2026-01-01"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts && python -m pytest tests/test_kalshi_ladder_model.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'kalshi_edges.ladder_model'`.

- [ ] **Step 3: Implement**

```python
"""Full-ladder bridge (spec 2026-11-11). Pure functions, no I/O.

Stretch the sportsbook model's calibrated P(over book line) across every Kalshi rung:
fit the player's stat distribution from prior game logs, solve one mean shift so
P(over anchor line) matches the model, then read P(X >= N) at each Kalshi strike.
"""
from collections import defaultdict
from statistics import mean

from kalshi_edges.prizm_data import apply_calibration

LADDER_STATS = ("points", "rebounds", "assists", "three_pointers", "pra")
LOG_WINDOW = 40


def anchor(scored, stat, calib):
    """(anchor_line, p_over) for one player/stat/game, or None.

    scored: dicts with line, direction ('over'|'under'), confidence_score.
    Each row's score is calibrated to P(that side hits); duplicate books are averaged.
    Lines with both sides scored win; among them (or among one-sided lines when none
    has both) the line whose P(over) is closest to 0.5 is the anchor."""
    by_line = defaultdict(lambda: {"over": [], "under": []})
    for r in scored:
        d, s = r.get("direction"), r.get("confidence_score")
        if d not in ("over", "under") or s is None:
            continue
        by_line[float(r["line"])][d].append(apply_calibration(calib, stat, float(s)))
    cands = []
    for line, d in by_line.items():
        if d["over"] and d["under"]:
            p, both = (mean(d["over"]) + 1 - mean(d["under"])) / 2, True
        elif d["over"]:
            p, both = mean(d["over"]), False
        else:
            p, both = 1 - mean(d["under"]), False
        cands.append((not both, abs(p - 0.5), line, p))
    if not cands:
        return None
    _, _, line, p = min(cands)
    return line, p


def prior_logs(logs, before_date, n=LOG_WINDOW):
    """Up to n games strictly before before_date (YYYY-MM-DD), newest first."""
    prior = [g for g in logs if str(g["game_date"])[:10] < before_date]
    prior.sort(key=lambda g: str(g["game_date"])[:10], reverse=True)
    return prior[:n]
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd scripts && python -m pytest tests/test_kalshi_ladder_model.py -q`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/ladder_model.py scripts/tests/test_kalshi_ladder_model.py
git commit -m "feat(kalshi): full-ladder anchor and prior-log helpers"
```

---

### Task 3: Bridge — ladder probabilities and rung rows

**Files:**
- Modify: `scripts/kalshi_edges/ladder_model.py`
- Test: `scripts/tests/test_kalshi_ladder_model.py`

- [ ] **Step 1: Add the failing tests** (append to the test file)

```python
from datetime import date
from kalshi_edges.ladder_model import ladder_probs, build_rungs, et_day_window, exact_strikes

def _logs(vals, stat_key="points", start_day=1):
    # one game per day in Jan 2026, 30 minutes each
    return [{"game_date": f"2026-01-{start_day + i:02d}", "minutes": 30, stat_key: v,
             "player_name": "Jaylen Brown"} for i, v in enumerate(vals)]

PTS = [18, 22, 25, 30, 21, 27, 24, 19, 26, 23, 28, 20, 25, 22, 31]

def test_exact_strikes_only_half_lines():
    rows = [sc(24.5, "over", 60), sc(29.5, "under", 40), sc(20.0, "over", 50)]
    assert exact_strikes(rows) == {25, 30}

def test_ladder_probs_monotone_and_matches_anchor():
    from kalshi_edges.prob_model import prob_over_line
    res, why = ladder_probs([sc(24.5, "over", 55), sc(24.5, "under", 45)], _logs(PTS),
                            "points", [15, 20, 25, 30, 35], "2026-02-01", CAL)
    assert why is None
    ps = [res["probs"][s] for s in (15, 20, 25, 30, 35)]
    assert all(a > b for a, b in zip(ps, ps[1:]))
    assert abs(res["probs"][25] - 0.55) < 0.01        # strike 25 == over 24.5
    assert res["exact"] == {15: False, 20: False, 25: True, 30: False, 35: False}

def test_ladder_probs_ignores_games_on_or_after_date():
    # 15 good games, then a 60-point game ON the game date: must not move the fit.
    logs = _logs(PTS) + [{"game_date": "2026-02-01", "minutes": 30, "points": 60, "player_name": "Jaylen Brown"}]
    a, _ = ladder_probs([sc(24.5, "over", 55)], _logs(PTS), "points", [30], "2026-02-01", CAL)
    b, _ = ladder_probs([sc(24.5, "over", 55)], logs, "points", [30], "2026-02-01", CAL)
    assert a["probs"][30] == b["probs"][30]

def test_ladder_probs_skip_reasons():
    assert ladder_probs([], _logs(PTS), "points", [25], "2026-02-01", CAL) == (None, "no_anchor")
    assert ladder_probs([sc(24.5, "over", 55)], _logs(PTS[:5]), "points", [25], "2026-02-01", CAL) == (None, "few_games")

def test_build_rungs_rows_and_skips():
    markets = [
        {"ticker": "T25", "player": "Jaylen Brown", "stat": "points", "strike": 25, "game_date": "2026-02-01"},
        {"ticker": "T30", "player": "Jaylen Brown", "stat": "points", "strike": 30, "game_date": "2026-02-01"},
        {"ticker": "U8", "player": "Nobody Known", "stat": "rebounds", "strike": 8, "game_date": "2026-02-01"},
        {"ticker": "DD", "player": "Jaylen Brown", "stat": "double_double", "strike": 1, "game_date": "2026-02-01"},
    ]
    scored = [{"player_name": "Jaylen Brown", "stat_type": "points", "line": 24.5, "direction": "over",
               "confidence_score": 55, "commence_time": "2026-02-02T00:30:00+00:00"}]
    rows, skips = build_rungs(markets, scored, _logs(PTS), CAL, "2026-02-01", "2026-02-01T23:00:00+00:00")
    by = {r["ticker"]: r for r in rows}
    assert set(by) == {"T25", "T30"}
    assert by["T25"]["exact"] is True and by["T30"]["exact"] is False
    assert by["T30"]["model_p"] < by["T25"]["model_p"]
    assert by["T30"]["commence_time"] == "2026-02-02T00:30:00+00:00"
    assert by["T30"]["computed_at"] == "2026-02-01T23:00:00+00:00"
    assert skips == {"no_anchor": 1}          # DD is not a ladder stat: ignored, not skipped

def test_build_rungs_matches_names_loosely():
    markets = [{"ticker": "T", "player": "Nikola Jokić", "stat": "points", "strike": 25, "game_date": "2026-02-01"}]
    scored = [{"player_name": "Nikola Jokic", "stat_type": "points", "line": 24.5, "direction": "over",
               "confidence_score": 55, "commence_time": None}]
    logs = [{**g, "player_name": "Nikola Jokic"} for g in _logs(PTS)]
    rows, _ = build_rungs(markets, scored, logs, CAL, "2026-02-01", "now")
    assert [r["ticker"] for r in rows] == ["T"]

def test_et_day_window_handles_dst():
    assert et_day_window(date(2026, 11, 11)) == ("2026-11-11T05:00:00+00:00", "2026-11-12T05:00:00+00:00")
    assert et_day_window(date(2026, 10, 21)) == ("2026-10-21T04:00:00+00:00", "2026-10-22T04:00:00+00:00")
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts && python -m pytest tests/test_kalshi_ladder_model.py -q`
Expected: FAIL, `ImportError: cannot import name 'ladder_probs'`.

- [ ] **Step 3: Implement** (append to `ladder_model.py`; add the imports at the top)

Top-of-file imports become:

```python
from collections import Counter, defaultdict
from datetime import datetime, time as dtime, timedelta, timezone
from statistics import mean
from zoneinfo import ZoneInfo

from kalshi_edges.find_edges import normalize_name
from kalshi_edges.prizm_data import apply_calibration
from kalshi_edges.prob_model import fit_distribution, prob_at_strike, solve_shift
```

Append:

```python
def exact_strikes(scored):
    """Strikes N where some scored .5 line sits at N - 0.5 (either direction)."""
    out = set()
    for r in scored:
        x = float(r["line"]) + 0.5
        if x.is_integer():
            out.add(int(x))
    return out


def ladder_probs(scored, logs, stat, strikes, game_date, calib):
    """({anchor_line, anchor_p, delta, probs{strike: p}, exact{strike: bool}}, None)
    or (None, reason) with reason in no_anchor | few_games | clamped."""
    a = anchor(scored, stat, calib)
    if a is None:
        return None, "no_anchor"
    line, p = a
    try:
        dist = fit_distribution(prior_logs(logs, game_date), stat)
    except ValueError:
        return None, "few_games"
    delta, clamped = solve_shift(dist, line, p)
    if clamped:
        return None, "clamped"
    ex = exact_strikes(scored)
    return {"anchor_line": line, "anchor_p": p, "delta": delta,
            "probs": {s: prob_at_strike(dist, delta, s) for s in strikes},
            "exact": {s: s in ex for s in strikes}}, None


def build_rungs(markets, scored, logs, calib, game_date, computed_at):
    """kalshi_model_rungs rows for one ET game date, plus Counter of skip reasons
    (one count per player/stat ladder). Markets outside LADDER_STATS are ignored.
    Names join on find_edges.normalize_name."""
    sc_idx = defaultdict(list)
    for r in scored:
        if r.get("stat_type") in LADDER_STATS:
            sc_idx[(normalize_name(r["player_name"]), r["stat_type"])].append(r)
    log_idx = defaultdict(list)
    for g in logs:
        log_idx[normalize_name(g["player_name"])].append(g)
    ladders = defaultdict(list)
    for m in markets:
        if m["stat"] in LADDER_STATS:
            ladders[(normalize_name(m["player"]), m["stat"])].append(m)

    rows, skips = [], Counter()
    for (name, stat), ms in ladders.items():
        rows_sc = sc_idx.get((name, stat), [])
        res, why = ladder_probs(rows_sc, log_idx.get(name, []), stat,
                                sorted({int(m["strike"]) for m in ms}), game_date, calib)
        if res is None:
            skips[why] += 1
            continue
        tips = sorted(r["commence_time"] for r in rows_sc if r.get("commence_time"))
        for m in ms:
            s = int(m["strike"])
            rows.append({"ticker": m["ticker"], "player": m["player"], "stat": stat, "strike": s,
                         "game_date": game_date, "model_p": round(res["probs"][s], 4),
                         "anchor_line": res["anchor_line"], "anchor_p": round(res["anchor_p"], 4),
                         "delta": round(res["delta"], 4), "exact": res["exact"][s],
                         "commence_time": tips[0] if tips else None, "computed_at": computed_at})
    return rows, dict(skips)


ET = ZoneInfo("America/New_York")


def et_day_window(d):
    """[start, end) of ET calendar date d as UTC ISO strings."""
    start = datetime.combine(d, dtime(0), tzinfo=ET).astimezone(timezone.utc)
    end = datetime.combine(d + timedelta(days=1), dtime(0), tzinfo=ET).astimezone(timezone.utc)
    return start.isoformat(), end.isoformat()
```

Note: `find_edges.py` imports `market_data`, `prizm_data`, `prob_model` at module top. If importing it pulls in network calls at import time (it should not), move `normalize_name` into `ladder_model.py` instead and leave `find_edges` alone.

- [ ] **Step 4: Run to verify they pass**

Run: `cd scripts && python -m pytest tests/test_kalshi_ladder_model.py -q`
Expected: 14 passed. If `test_ladder_probs_monotone_and_matches_anchor` misses the 0.01 tolerance on strike 25, check `prob_at_strike` passes `strike - 1` (continuity correction) — the bridge is solved on P(X > 24.5) and strike 25 reads P(X > 24 + 0.5), which is the same quantity.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/ladder_model.py scripts/tests/test_kalshi_ladder_model.py
git commit -m "feat(kalshi): full-ladder bridge builds per-rung model probabilities"
```

---

### Task 4: Live step `kalshi_model_rungs`

**Files:**
- Create: `scripts/kalshi_model_rungs.py`
- Modify: `scripts/pipeline/phases.py` (the `'kalshi_live'` list)
- Modify: `scripts/tests/test_pipeline_phases.py:27,32`

- [ ] **Step 1: Update the phase tests first**

In `test_other_phases`:

```python
    assert names('kalshi_live') == ['kalshi_ingest', 'kalshi_model_rungs', 'kalshi_model_log', 'kalshi_pocket_scan']
```

In `test_kalshi_steps_own_chain_not_critical`:

```python
    assert len(ks) == 10
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts && python -m pytest tests/test_pipeline_phases.py -q`
Expected: 2 failed.

- [ ] **Step 3: Add the step to `phases.py`**

```python
    'kalshi_live': [
        Step('kalshi_ingest', 'kalshi', 'python', 'kalshi_ingest.py', 0),
        Step('kalshi_model_rungs', 'kalshi', 'python', 'kalshi_model_rungs.py', 0),
        Step('kalshi_model_log', 'kalshi', 'http', '/api/markets/model-picks/log', 0),
        Step('kalshi_pocket_scan', 'kalshi', 'python', 'kalshi_pocket_scan.py', 0),
    ],
```

- [ ] **Step 4: Write `scripts/kalshi_model_rungs.py`**

```python
"""Pipeline step (kalshi_live, every 15 min): price every Kalshi ladder rung for today's
games from the sportsbook model (full-ladder bridge, spec 2026-11-11) into kalshi_model_rungs."""
import os, sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.ladder_model import LADDER_STATS, build_rungs, et_day_window  # noqa: E402
from kalshi_edges.prizm_data import load_calibration  # noqa: E402

LOG_COLS = "player_name,game_date,minutes,points,rebounds,assists,fg3m,pra"
SCORED_COLS = "player_name,stat_type,line,direction,confidence_score,commence_time"
LOG_LOOKBACK_DAYS = 400   # covers 40 games across an offseason


def _in(values):
    return ",".join(f'"{quote(v)}"' for v in values)


if __name__ == '__main__':
    load_env_local()
    today = datetime.now(ZoneInfo('America/New_York')).date()
    stats = ",".join(LADDER_STATS)
    markets = sb.select_all("kalshi_markets", f"select=ticker,player,stat,strike,game_date"
                                              f"&game_date=eq.{today.isoformat()}&stat=in.({stats})&order=ticker")
    if not markets:
        print("kalshi_model_rungs: no ladder markets today"); sys.exit(0)
    start, end = et_day_window(today)
    scored = []
    for table in ("props", "prop_alts"):
        scored += sb.select_all(table, f"select={SCORED_COLS}&confidence_score=not.is.null"
                                       f"&stat_type=in.({stats})&commence_time=gte.{quote(start)}"
                                       f"&commence_time=lt.{quote(end)}&order=id")
    names = sorted({r["player_name"] for r in scored})
    since = (today - timedelta(days=LOG_LOOKBACK_DAYS)).isoformat()
    logs = []
    for i in range(0, len(names), 40):
        logs += sb.select_all("player_game_logs", f"select={LOG_COLS}&player_name=in.({_in(names[i:i + 40])})"
                                                  f"&game_date=gte.{since}&order=id")
    now = datetime.now(timezone.utc).isoformat()
    rows, skips = build_rungs(markets, scored, logs, load_calibration(), today.isoformat(), now)
    n = sb.upsert("kalshi_model_rungs", rows, "ticker")
    exact = sum(r["exact"] for r in rows)
    print(f"kalshi_model_rungs: {len(markets)} markets, {n} rungs priced ({exact} exact, {n - exact} stretched), "
          f"skipped ladders {skips}")
```

- [ ] **Step 5: Run tests, then a live smoke run on a game day**

Run: `cd scripts && python -m pytest tests -q`
Expected: all pass.

Run: `cd scripts && python kalshi_model_rungs.py`
Expected on a game day: a line like `kalshi_model_rungs: 480 markets, 300+ rungs priced (… exact, … stretched), skipped ladders {...}`. Then in SQL:

```sql
select stat, count(*), sum((exact)::int) exact, round(avg(model_p),3) from kalshi_model_rungs
where game_date = (now() at time zone 'America/New_York')::date group by 1;
```
Spot-check one player: `model_p` falls as `strike` rises. If `player_game_logs` names never match (0 logs, every ladder skipped as `few_games`), print `names[:5]` and a sample of logs names and fix the join before continuing.

- [ ] **Step 6: Commit**

```bash
git add scripts/kalshi_model_rungs.py scripts/pipeline/phases.py scripts/tests/test_pipeline_phases.py
git commit -m "feat(pipeline): kalshi_model_rungs prices every ladder rung every 15 min"
```

---

### Task 5: TS — kinds, `matchStretched`, `visiblePicks`

**Files:**
- Modify: `lib/kalshi/model-picks.ts`
- Test: `lib/__tests__/kalshi-model-picks.test.ts`

- [ ] **Step 1: Write the failing tests**

Change the import at the top of the test file to:

```ts
import {
  matchPicks, matchStretched, visiblePicks, summarizeRecord, rungLabel, groupPicksByGame, etDayWindow, dueForLogging,
  toLogRow, summarizeBy, type ScoredLine, type ModelPick, type ModelRung,
} from '@/lib/kalshi/model-picks'
```

Update the existing `toLogRow` expectation to include `kind: 'exact'`:

```ts
    expect(r).toEqual({ ticker: base.ticker, side: 'yes', player: 'Jaylen Brown', stat: 'points', strike: 25,
      game_date: '2026-11-11', tier: 'LOCK', kind: 'exact', model_p: 0.6512, price: 0.58, fee: 0.017052, edge: 0.0542 })
```

Append:

```ts
describe('matchPicks kind', () => {
  it('marks exact-line picks as exact', () => {
    expect(matchPicks([mkt({})], [line({})])[0].kind).toBe('exact')
  })
})

describe('matchStretched', () => {
  const now = new Date('2026-11-11T23:00:00Z')
  const rung = (o: Partial<ModelRung>): ModelRung => ({
    ticker: mkt({}).ticker, model_p: 0.7, exact: false,
    commence_time: '2026-11-12T00:30:00Z', computed_at: '2026-11-11T22:50:00Z', ...o,
  })

  it('picks YES when model_p beats ask + fee', () => {
    const [p] = matchStretched([mkt({ yes_bid: 0.6, yes_ask: 0.62 })], [rung({})], now)
    expect(p.side).toBe('yes')
    expect(p.kind).toBe('stretched')
    expect(p.tier).toBe('STRETCH')
    expect(p.price).toBe(0.62)
    expect(p.edge).toBeCloseTo(0.7 - 0.62 - kalshiFee(0.62))
    expect(p.commence_time).toBe('2026-11-12T00:30:00Z')
  })

  it('picks NO at 1 - bid when the model is below the market', () => {
    const [p] = matchStretched([mkt({ yes_bid: 0.40, yes_ask: 0.42 })], [rung({ model_p: 0.3 })], now)
    expect(p.side).toBe('no')
    expect(p.price).toBe(0.6)
    expect(p.modelP).toBeCloseTo(0.7)
    expect(p.edge).toBeCloseTo(0.7 - 0.6 - kalshiFee(0.6))
  })

  it('skips exact rungs, stale rungs, missing tip times, wide books and big gaps', () => {
    const m = mkt({ yes_bid: 0.6, yes_ask: 0.62 })
    expect(matchStretched([m], [rung({ exact: true })], now)).toHaveLength(0)
    expect(matchStretched([m], [rung({ computed_at: '2026-11-11T22:14:00Z' })], now)).toHaveLength(0)
    expect(matchStretched([m], [rung({ commence_time: null })], now)).toHaveLength(0)
    expect(matchStretched([mkt({ yes_bid: 0.5, yes_ask: 0.62 })], [rung({})], now)).toHaveLength(0)
    expect(matchStretched([m], [rung({ model_p: 0.9 })], now)).toHaveLength(0)   // gap > MAX_MODEL_MARKET_GAP
  })

  it('ignores DD/TD markets', () => {
    const m = mkt({ stat: 'double_double', yes_bid: 0.6, yes_ask: 0.62 })
    expect(matchStretched([m], [rung({})], now)).toHaveLength(0)
  })
})

describe('visiblePicks', () => {
  const ex = { ...matchPicks([mkt({})], [line({})])[0], edge: 0.02 }
  const st = { ...ex, ticker: 'S', kind: 'stretched' as const, tier: 'STRETCH' as const, edge: 0.05 }
  it('shows only exact picks while stretched are hidden', () => {
    expect(visiblePicks([ex], [st], false).map((p) => p.ticker)).toEqual([ex.ticker])
  })
  it('merges and sorts by edge when stretched are visible', () => {
    expect(visiblePicks([ex], [st], true).map((p) => p.ticker)).toEqual(['S', ex.ticker])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/__tests__/kalshi-model-picks.test.ts`
Expected: FAIL, `matchStretched is not a function` (and the `toLogRow` expectation).

- [ ] **Step 3: Implement in `lib/kalshi/model-picks.ts`**

Replace the tier type and extend `ModelPick`:

```ts
export type PickTier = 'LOCK' | 'PLAY' | 'STRETCH'
export type PickKind = 'exact' | 'stretched'
```

Add `kind: PickKind` to `interface ModelPick` (after `tier`).

Add after the existing constants:

```ts
/** Stretched (full-ladder) picks show on Home/Feed only once the 2025-26 replay passes
 *  (spec 2026-11-11). Until then they are logged and graded, visible on Performance only. */
export const STRETCHED_VISIBLE = false
/** kalshi_model_rungs rows older than this are ignored (a dead step means no picks, not stale ones). */
export const RUNG_MAX_AGE_MIN = 45

export interface ModelRung {
  ticker: string
  model_p: number
  exact: boolean
  commence_time: string | null
  computed_at: string
}
```

In `matchPicks`, add `kind: 'exact',` to the pick object literal (next to `tier: s.confidence_label,`). Because `confidence_label` is a `string`, keep the existing cast/filter as is; the object now satisfies `ModelPick` with `tier` narrowed by the LOCK/PLAY guard above it (if tsc complains, write `tier: s.confidence_label as PickTier`).

Add after `matchPicks`:

```ts
/** Picks on rungs priced by the full-ladder bridge (kalshi_model_rungs), excluding exact
 *  rungs (left to matchPicks). Same book/price/edge filters as exact picks; the better side wins. */
export function matchStretched(markets: MarketRow[], rungs: ModelRung[], now: Date): ModelPick[] {
  const byTicker = new Map(rungs.map((r) => [r.ticker, r]))
  const out: ModelPick[] = []
  for (const m of markets) {
    if (!PICK_STATS.has(m.stat)) continue
    const r = byTicker.get(m.ticker)
    if (!r || r.exact || r.commence_time == null) continue
    const age = now.getTime() - Date.parse(r.computed_at)
    if (!Number.isFinite(age) || age > RUNG_MAX_AGE_MIN * 60_000) continue
    const { yes_bid: bid, yes_ask: ask } = m
    if (bid == null || ask == null || bid <= 0 || ask <= 0) continue
    if (Math.round((ask - bid) * 100) > MAX_SPREAD_CENTS) continue

    let best: ModelPick | null = null
    for (const side of ['yes', 'no'] as const) {
      const price = side === 'yes' ? ask : round(1 - bid, 4)
      if (price < MIN_PRICE || price > MAX_PRICE) continue
      const modelP = side === 'yes' ? Number(r.model_p) : 1 - Number(r.model_p)
      const fee = kalshiFee(price)
      const edge = modelP - (price + fee)
      if (!(edge > 0 && edge <= MAX_MODEL_MARKET_GAP)) continue
      if (best && best.edge >= edge) continue
      best = {
        ticker: m.ticker, side, player: m.player, stat: m.stat, strike: Number(m.strike),
        game_date: m.game_date, away: m.away, home: m.home, tier: 'STRETCH', kind: 'stretched',
        modelP, price, fee, edge, commence_time: r.commence_time,
      }
    }
    if (best) out.push(best)
  }
  return out.sort((a, b) => b.edge - a.edge)
}

/** Picks shown on Home/Feed: exact only, or exact + stretched by edge once STRETCHED_VISIBLE. */
export function visiblePicks(exact: ModelPick[], stretched: ModelPick[], showStretched = STRETCHED_VISIBLE): ModelPick[] {
  return showStretched ? [...exact, ...stretched].sort((a, b) => b.edge - a.edge) : exact
}
```

In `toLogRow`, add `kind: p.kind,` after `tier: p.tier,`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run lib/__tests__/kalshi-model-picks.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/kalshi/model-picks.ts lib/__tests__/kalshi-model-picks.test.ts
git commit -m "feat(markets): stretched Kalshi picks from full-ladder rungs"
```

---

### Task 6: TS — loader, log route, pages

**Files:**
- Modify: `lib/kalshi/model-picks-data.ts`
- Modify: `app/api/markets/model-picks/log/route.ts`
- Modify: `components/ModelPicks.tsx`
- Modify: `app/markets/page.tsx`, `app/markets/feed/page.tsx`, `app/markets/performance/page.tsx`

- [ ] **Step 1: Loader** (`lib/kalshi/model-picks-data.ts`)

Update the import:

```ts
import {
  etDayWindow, matchPicks, matchStretched, visiblePicks, type ModelPick, type ModelRung, type ScoredLine,
} from '@/lib/kalshi/model-picks'
```

Add a rung loader:

```ts
async function loadRungs(client: SupabaseClient, gameDate: string): Promise<ModelRung[]> {
  const out: ModelRung[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from('kalshi_model_rungs')
      .select('ticker, model_p, exact, commence_time, computed_at')
      .eq('game_date', gameDate).order('ticker').range(from, from + PAGE - 1)
    if (error) throw new Error(`kalshi_model_rungs: ${error.message}`)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      out.push({ ...(r as unknown as ModelRung), model_p: Number(r.model_p) })
    }
    if (!data || data.length < PAGE) break
  }
  return out
}
```

Replace `TodayPicks` and `loadTodayPicks`:

```ts
export interface TodayPicks {
  gameDate: string
  markets: number
  picks: ModelPick[]       // exact-line picks
  stretched: ModelPick[]   // full-ladder picks (paper until STRETCHED_VISIBLE)
  visible: ModelPick[]     // what Home/Feed show
}

/** Today's model picks (ET), each list sorted by edge desc. Throws on a query error. */
export async function loadTodayPicks(client: SupabaseClient, now = new Date()): Promise<TodayPicks> {
  const gameDate = todayEt(now)
  const [markets, props, alts, rungs] = await Promise.all([
    loadMarkets(client, gameDate),
    loadScored(client, 'props', gameDate),
    loadScored(client, 'prop_alts', gameDate),
    loadRungs(client, gameDate),
  ])
  const picks = matchPicks(markets, [...props, ...alts])
  const stretched = matchStretched(markets, rungs, now)
  return { gameDate, markets: markets.length, picks, stretched, visible: visiblePicks(picks, stretched) }
}
```

Add `kind: 'exact' | 'stretched'` to `ModelPickRow` (after `tier`), and add `kind` to the `loadLoggedPicks` select list:

```ts
      .select('id, ticker, side, player, stat, strike, game_date, tier, kind, model_p, price, fee, edge, logged_at, result, won, pnl')
```

- [ ] **Step 2: Log route** (`app/api/markets/model-picks/log/route.ts`)

Replace the body of the `try` block's first lines:

```ts
    const now = new Date()
    const { gameDate, markets, picks, stretched } = await loadTodayPicks(supabase, now)
    const due = dueForLogging([...picks, ...stretched], now)
```

and the response:

```ts
    return NextResponse.json({
      game_date: gameDate, markets, picks: picks.length, stretched: stretched.length, candidates: due.length, logged,
    })
```

Update the header comment's first line to "Logs today's Kalshi model picks (exact and stretched) for games tipping in the next 30 minutes".

- [ ] **Step 3: Badge style** (`components/ModelPicks.tsx`)

```ts
const TIER_STYLE: Record<string, string> = {
  LOCK: 'bg-[#00D68F]/15 text-[#00D68F] border-[#00D68F]/25',
  PLAY: 'bg-[#FFB800]/15 text-[#FFB800] border-[#FFB800]/25',
  STRETCH: 'bg-sky-400/15 text-sky-300 border-sky-400/25',
}
```

- [ ] **Step 4: Home and Feed show `visible`**

`app/markets/page.tsx`: import `STRETCHED_VISIBLE` from `@/lib/kalshi/model-picks`, change the picks load to `.then((r) => r.visible)`, and compute the record over visible kinds:

```tsx
  const shown = STRETCHED_VISIBLE ? logged : logged.filter((r) => r.kind !== 'stretched')
```

and render `<RecordLine r={summarizeRecord(shown)} />`.

`app/markets/feed/page.tsx`: change `.then((r) => r.picks)` to `.then((r) => r.visible)`.

- [ ] **Step 5: Performance "By kind"** (`app/markets/performance/page.tsx`)

After `byStat`:

```tsx
  const KIND_LABEL: Record<string, string> = { exact: 'Exact line', stretched: 'Stretched (paper)' }
  const byKind = summarizeBy(graded, (r) => r.kind ?? 'exact')
    .map((g) => ({ ...g, label: KIND_LABEL[g.key] ?? g.key }))
```

Change the two-table grid to three tables:

```tsx
          <div className="grid gap-6 md:grid-cols-3">
            <RecordTable title="By kind" rows={byKind} />
            <RecordTable title="By tier" rows={byTier} />
            <RecordTable title="By stat" rows={byStat} />
          </div>
```

Add one sentence under the header description:

```tsx
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          Stretched picks price every Kalshi rung from the model&apos;s sportsbook line. They are paper-only until a
          pre-registered replay on last season passes.
        </p>
```

- [ ] **Step 6: Verify types, lint, tests**

Run: `npx tsc --noEmit && npx eslint . && npx vitest run`
Expected: tsc clean, eslint 0 errors, all tests pass.

- [ ] **Step 7: Verify in the browser**

Start the dev server (`preview_start` with the project's launch config), open `/markets`, `/markets/feed`, `/markets/performance`. Expected: Home/Feed unchanged apart from data (stretched hidden); Performance shows "By kind" (only "Exact line" until stretched picks are graded); no console errors. Hit `/api/markets/model-picks/log` with the cron auth header and confirm the JSON has a `stretched` count.

- [ ] **Step 8: Commit**

```bash
git add lib/kalshi/model-picks-data.ts app/api/markets/model-picks/log/route.ts components/ModelPicks.tsx app/markets/page.tsx app/markets/feed/page.tsx app/markets/performance/page.tsx
git commit -m "feat(markets): log stretched picks as paper; Performance record by kind"
```

---

### Task 7: Replay — pure module

**Files:**
- Create: `scripts/kalshi_edges/ladder_replay.py`
- Test: `scripts/tests/test_kalshi_ladder_replay.py`

The side/filter rule here must match `matchStretched` in `lib/kalshi/model-picks.ts` exactly (price 0.05–0.95, spread <= 10c, 0 < edge <= 0.10, better side wins).

- [ ] **Step 1: Write the failing tests**

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from kalshi_edges.fees import taker_fee
from kalshi_edges.ladder_replay import (pick_side, replay, verdict, replay_complete, render_report,
                                        brier, calibration_bins)

CAL = {"lookup": [float(i) for i in range(101)], "per_stat": {}}
PTS = [18, 22, 25, 30, 21, 27, 24, 19, 26, 23, 28, 20, 25, 22, 31]

def test_pick_side_yes_no_and_filters():
    s = pick_side(0.70, 0.60, 0.62)
    assert s[0] == "yes" and s[1] == 0.62 and abs(s[3] - (0.70 - 0.62 - taker_fee(0.62))) < 1e-12
    s = pick_side(0.30, 0.40, 0.42)
    assert s[0] == "no" and s[1] == 0.6
    assert pick_side(0.70, 0.50, 0.62) is None        # spread 12c
    assert pick_side(0.90, 0.60, 0.62) is None        # gap > 0.10
    assert pick_side(0.99, 0.96, 0.97) is None        # price > 0.95
    assert pick_side(0.70, None, 0.62) is None        # one-sided book

def _settled(strike, bid, ask, result, day="2026-02-01", player="Jaylen Brown"):
    return {"ticker": f"T{strike}-{day}", "player": player, "stat": "points", "strike": strike,
            "game_date": day, "season": "2025-26", "pretip_yes_bid": bid, "pretip_yes_ask": ask, "result": result}

def _logs():
    return [{"game_date": f"2026-01-{1 + i:02d}", "minutes": 30, "points": v, "player_name": "Jaylen Brown"}
            for i, v in enumerate(PTS)]

def _grade(line, direction, score, day="2026-02-01"):
    return {"game_date": day, "player_name": "Jaylen Brown", "stat_type": "points",
            "line": line, "direction": direction, "confidence_score": score}

def test_replay_skips_exact_rungs_and_voids():
    settled = [_settled(25, 0.50, 0.52, "yes"),      # exact (24.5 graded): never a trade
               _settled(30, 0.05, 0.07, "no"),       # stretched
               _settled(35, 0.01, 0.03, "void")]     # void: ignored
    out = replay(settled, [_grade(24.5, "over", 55)], _logs(), CAL)
    assert all(t.ticker != "T25-2026-02-01" for t in out["trades"])
    assert all(not t.ticker.startswith("T35") for t in out["trades"])
    assert out["evals"] and all(e["strike"] != 25 for e in out["evals"])

def test_replay_trade_pnl():
    # Model P(30+) is ~0.12 for this fixture, so YES at 5c is a qualifying trade.
    settled = [_settled(30, 0.03, 0.05, "yes")]
    out = replay(settled, [_grade(24.5, "over", 55)], _logs(), CAL)
    assert out["trades"]
    for t in out["trades"]:
        won = (t.side == "yes")
        assert t.won == won
        assert abs(t.pnl - ((1 - t.price - t.fee) if won else -(t.price + t.fee))) < 1e-12

def test_replay_counts_skips():
    out = replay([_settled(30, 0.10, 0.12, "yes", player="Nobody Known")], [], [], CAL)
    assert out["skips"] == {"no_anchor": 1}

class T:
    def __init__(self, day, pnl, price=0.5, fee=0.0175, ticker="x", side="yes"):
        self.game_date, self.pnl, self.price, self.fee, self.ticker, self.side = day, pnl, price, fee, ticker, side

def test_verdict_bar():
    good = [T(f"2026-01-{d:02d}", 0.2 if i % 3 else -0.1, ticker=f"t{i}") for d in range(1, 31) for i in range(12)]
    v = verdict(good)
    assert v["n"] == 360 and v["roi"] >= 0.03 and v["pass"] is True
    assert verdict(good[:299])["pass"] is False                       # n < 300
    flat = [T(f"2026-01-{d:02d}", 0.0, ticker=f"t{i}") for d in range(1, 31) for i in range(12)]
    assert verdict(flat)["pass"] is False                             # roi 0

def test_replay_complete_guard():
    rows = [{"season": "2025-26", "stat": s, "game_date": "2025-11-20"}
            for s in ("points", "rebounds", "assists", "three_pointers", "pra")]
    assert replay_complete(rows) == (True, "")
    assert replay_complete(rows[:3])[0] is False
    late = [{**r, "game_date": "2025-12-15"} for r in rows]
    assert replay_complete(late)[0] is False

def test_brier_and_bins():
    ev = [{"model_p": 0.8, "mid": 0.6, "y": 1, "stat": "points"},
          {"model_p": 0.2, "mid": 0.4, "y": 0, "stat": "points"}]
    b = brier(ev)
    assert abs(b["model"] - 0.04) < 1e-12 and abs(b["market"] - 0.16) < 1e-12 and b["n"] == 2
    bins = calibration_bins(ev)
    assert [x["bin"] for x in bins] == ["0.2-0.3", "0.8-0.9"]

def test_render_report_states_result():
    md = render_report({"verdict": {"n": 0, "roi": 0.0, "roi_h1": 0.0, "roi_h2": 0.0, "p": 1.0, "pass": False},
                        "by_stat": [], "by_distance": [], "brier": {"n": 0, "model": None, "market": None},
                        "calibration": [], "skips": {}, "n_settled": 0})
    assert "FAIL" in md and "discovery" in md.lower()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts && python -m pytest tests/test_kalshi_ladder_replay.py -q`
Expected: FAIL, `ModuleNotFoundError: No module named 'kalshi_edges.ladder_replay'`.

- [ ] **Step 3: Implement**

```python
"""Full-ladder replay on 2025-26 (spec 2026-11-11). Pure functions.

Discovery only: the calibration table overlaps this season. The bar below is fixed by the
spec; do not change filters or bars after seeing results."""
from collections import defaultdict
from dataclasses import dataclass

from kalshi_edges.fees import taker_fee
from kalshi_edges.find_edges import normalize_name
from kalshi_edges.ladder_model import LADDER_STATS, ladder_probs
from kalshi_edges.study import pocket_stats

SEASON = "2025-26"
LATEST_START = "2025-11-25"
MIN_N, MIN_ROI, ALPHA = 300, 0.03, 0.05
# Mirror of lib/kalshi/model-picks.ts matchStretched filters.
MIN_PRICE, MAX_PRICE, MAX_SPREAD_CENTS, MAX_GAP = 0.05, 0.95, 10, 0.10


def _r4(x):
    return None if x is None else round(float(x), 4)


def pick_side(model_p, bid, ask):
    """(side, price, fee, edge) for the better qualifying side, or None."""
    if bid is None or ask is None or bid <= 0 or ask <= 0:
        return None
    if round((ask - bid) * 100) > MAX_SPREAD_CENTS:
        return None
    best = None
    for side, price, p in (("yes", _r4(ask), model_p), ("no", _r4(1 - bid), 1 - model_p)):
        if price < MIN_PRICE or price > MAX_PRICE:
            continue
        fee = taker_fee(price)
        edge = p - (price + fee)
        if not (0 < edge <= MAX_GAP):
            continue
        if best is None or edge > best[3]:
            best = (side, price, fee, edge)
    return best


@dataclass
class Trade:
    ticker: str
    game_date: str
    stat: str
    distance: float    # strike - (anchor_line + 0.5), in stat units
    side: str
    price: float
    fee: float
    model_p: float
    won: bool
    pnl: float


def replay(settled, grades, logs, calib):
    """{trades, evals, skips} over settled 2025-26 ladder rungs (non-void, ladder stats).
    grades: prop_grades rows (game_date, player_name, stat_type, line, direction, confidence_score).
    evals: every priced non-exact rung with a two-sided book (for Brier/calibration)."""
    ladders = defaultdict(list)
    for r in settled:
        if r.get("season") == SEASON and r["stat"] in LADDER_STATS and r.get("result") in ("yes", "no"):
            ladders[(str(r["game_date"])[:10], normalize_name(r["player"]), r["stat"])].append(r)
    g_idx = defaultdict(list)
    for g in grades:
        g_idx[(str(g["game_date"])[:10], normalize_name(g["player_name"]), g["stat_type"])].append(g)
    log_idx = defaultdict(list)
    for g in logs:
        log_idx[normalize_name(g["player_name"])].append(g)

    trades, evals, skips = [], [], defaultdict(int)
    for (day, name, stat), rungs in sorted(ladders.items()):
        res, why = ladder_probs(g_idx.get((day, name, stat), []), log_idx.get(name, []), stat,
                                sorted({int(r["strike"]) for r in rungs}), day, calib)
        if res is None:
            skips[why] += 1
            continue
        for r in rungs:
            s = int(r["strike"])
            if res["exact"][s]:
                continue
            p = res["probs"][s]
            y = 1 if r["result"] == "yes" else 0
            bid, ask = _r4(r.get("pretip_yes_bid")), _r4(r.get("pretip_yes_ask"))
            if bid is not None and ask is not None:
                evals.append({"model_p": p, "mid": (bid + ask) / 2, "y": y, "stat": stat, "strike": s})
            pick = pick_side(p, bid, ask)
            if pick is None:
                continue
            side, price, fee, _ = pick
            won = (side == "yes") == (y == 1)
            trades.append(Trade(ticker=r["ticker"], game_date=day, stat=stat,
                                distance=s - (res["anchor_line"] + 0.5), side=side, price=price, fee=fee,
                                model_p=p if side == "yes" else 1 - p, won=won,
                                pnl=(1 - price - fee) if won else -(price + fee)))
    return {"trades": trades, "evals": evals, "skips": dict(skips)}


def verdict(trades):
    """Pre-registered bar: n >= 300, ROI >= +3%, both halves > 0, day-clustered one-sided p < 0.05."""
    s = pocket_stats(trades) if trades else {"n": 0, "roi": 0.0, "roi_h1": 0.0, "roi_h2": 0.0, "p": 1.0}
    s["pass"] = bool(s["n"] >= MIN_N and s["roi"] >= MIN_ROI and s["roi_h1"] > 0
                     and s["roi_h2"] > 0 and s["p"] < ALPHA)
    return s


def replay_complete(rows):
    """(ok, reason): 2025-26 settled rows cover all ladder stats and start early enough."""
    disc = [r for r in rows if r.get("season") == SEASON]
    missing = [s for s in LADDER_STATS if s not in {r["stat"] for r in disc}]
    if missing:
        return False, f"{SEASON} rows missing stats: {', '.join(missing)}"
    earliest = min(str(r["game_date"])[:10] for r in disc)
    if earliest > LATEST_START:
        return False, f"earliest {SEASON} game_date is {earliest} (> {LATEST_START})"
    return True, ""


def brier(evals):
    if not evals:
        return {"n": 0, "model": None, "market": None}
    n = len(evals)
    return {"n": n, "model": sum((e["model_p"] - e["y"]) ** 2 for e in evals) / n,
            "market": sum((e["mid"] - e["y"]) ** 2 for e in evals) / n}


def calibration_bins(evals):
    """Model_p deciles: n, mean model_p, realized YES rate (non-empty bins only)."""
    bins = defaultdict(list)
    for e in evals:
        k = min(int(e["model_p"] * 10), 9)
        bins[k].append(e)
    return [{"bin": f"{k / 10:.1f}-{(k + 1) / 10:.1f}", "n": len(es),
             "mean_p": sum(e["model_p"] for e in es) / len(es),
             "yes_rate": sum(e["y"] for e in es) / len(es)} for k, es in sorted(bins.items())]


def _group(trades, key):
    groups = defaultdict(list)
    for t in trades:
        groups[key(t)].append(t)
    return [{"key": k, **verdict(ts)} for k, ts in sorted(groups.items())]


def _dist_bucket(d):
    a = abs(d)
    return "1 step" if a <= 2 else "2 steps" if a <= 5 else "3+ steps"


def summarize(out, n_settled):
    trades = out["trades"]
    return {"verdict": verdict(trades), "by_stat": _group(trades, lambda t: t.stat),
            "by_distance": _group(trades, lambda t: _dist_bucket(t.distance)),
            "brier": brier(out["evals"]), "calibration": calibration_bins(out["evals"]),
            "skips": out["skips"], "n_settled": n_settled}


def _pct(x):
    return "—" if x is None else f"{x * 100:+.1f}%"


def render_report(s):
    v = s["verdict"]
    lines = [
        "# Kalshi full-ladder replay (2025-26, discovery)", "",
        "Spec: `docs/superpowers/specs/2026-11-11-kalshi-full-ladder-design.md`.",
        "Calibration table overlaps this season, so this is discovery only; the forward",
        "2026-27 record is the real test.", "",
        f"**Result: {'PASS' if v['pass'] else 'FAIL'}** — n={v['n']}, ROI {_pct(v['roi'])}, "
        f"halves {_pct(v['roi_h1'])} / {_pct(v['roi_h2'])}, p={v['p']:.4f} "
        f"(bar: n>=300, ROI>=+3%, both halves >0, p<0.05).", "",
        f"Settled ladder rungs read: {s['n_settled']}. Ladders skipped: {s['skips'] or 'none'}.", "",
        "## By stat (reported, not gated)", "", "| stat | n | ROI | p |", "|---|---|---|---|",
        *[f"| {g['key']} | {g['n']} | {_pct(g['roi'])} | {g['p']:.3f} |" for g in s["by_stat"]], "",
        "## By distance from the book line (reported, not gated)", "", "| distance | n | ROI | p |", "|---|---|---|---|",
        *[f"| {g['key']} | {g['n']} | {_pct(g['roi'])} | {g['p']:.3f} |" for g in s["by_distance"]], "",
        "## Brier (non-exact rungs with a two-sided book)", "",
    ]
    b = s["brier"]
    lines.append("No rungs." if not b["n"] else
                 f"n={b['n']}: model {b['model']:.4f} vs Kalshi mid {b['market']:.4f} (lower is better).")
    lines += ["", "## Calibration of model_p", "", "| bin | n | mean model_p | YES rate |", "|---|---|---|---|",
              *[f"| {c['bin']} | {c['n']} | {c['mean_p']:.3f} | {c['yes_rate']:.3f} |" for c in s["calibration"]], ""]
    return "\n".join(lines)
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd scripts && python -m pytest tests/test_kalshi_ladder_replay.py -q`
Expected: all pass. If `test_replay_trade_pnl` fails on `assert out["trades"]`, the fixture's model P(30+) is not near 0.12: print `ladder_probs(...)["probs"][30]` for the fixture and set the ask 3-8 cents below it (keeping ask >= 0.05 and a 2c spread). Do not loosen the filters.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/ladder_replay.py scripts/tests/test_kalshi_ladder_replay.py
git commit -m "feat(kalshi): pre-registered full-ladder replay (pure)"
```

---

### Task 8: Replay — entry script

**Files:**
- Create: `scripts/kalshi_ladder_replay.py`

- [ ] **Step 1: Write the script**

```python
"""Run the full-ladder replay on 2025-26 (spec 2026-11-11). PC only, once, after the
kalshi_settled backfill covers all 5 ladder stats and the strike-fix SQL has run.
Usage: python kalshi_ladder_replay.py [--report]
  --report writes docs/kalshi-study/<date>-full-ladder-replay.{md,json} (commit them by hand)."""
import json, os, sys
from dataclasses import asdict
from datetime import date
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.ladder_model import LADDER_STATS  # noqa: E402
from kalshi_edges.ladder_replay import SEASON, render_report, replay, replay_complete, summarize  # noqa: E402
from kalshi_edges.prizm_data import load_calibration  # noqa: E402

SETTLED_COLS = "ticker,player,stat,strike,game_date,season,pretip_yes_bid,pretip_yes_ask,result"
GRADE_COLS = "game_date,player_name,stat_type,line,direction,confidence_score"
LOG_COLS = "player_name,game_date,minutes,points,rebounds,assists,fg3m,pra"

if __name__ == '__main__':
    load_env_local()
    stats = ",".join(LADDER_STATS)
    settled = sb.select_all("kalshi_settled", f"select={SETTLED_COLS}&season=eq.{SEASON}&stat=in.({stats})&order=ticker")
    ok, reason = replay_complete(settled)
    if not ok:
        print(f"kalshi_ladder_replay: backfill incomplete ({reason})"); sys.exit(1)
    lo = min(str(r["game_date"])[:10] for r in settled)
    hi = max(str(r["game_date"])[:10] for r in settled)
    grades = sb.select_all("prop_grades", f"select={GRADE_COLS}&game_date=gte.{lo}&game_date=lte.{hi}"
                                          f"&stat_type=in.({stats})&confidence_score=not.is.null&order=id")
    logs = sb.select_all("player_game_logs", f"select={LOG_COLS}&game_date=gte.2024-10-01&game_date=lte.{hi}&order=id")
    print(f"kalshi_ladder_replay: {len(settled)} settled rungs, {len(grades)} graded lines, {len(logs)} logs")
    out = replay(settled, grades, logs, load_calibration())
    s = summarize(out, len(settled))
    v = s["verdict"]
    print(f"result: {'PASS' if v['pass'] else 'FAIL'} n={v['n']} roi={v['roi']:+.4f} "
          f"h1={v['roi_h1']:+.4f} h2={v['roi_h2']:+.4f} p={v['p']:.4f}; skips {s['skips']}")
    if '--report' in sys.argv:
        d = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'kalshi-study')
        os.makedirs(d, exist_ok=True)
        stem = os.path.join(d, f"{date.today().isoformat()}-full-ladder-replay")
        with open(stem + '.md', 'w', encoding='utf-8') as f:
            f.write(render_report(s))
        with open(stem + '.json', 'w', encoding='utf-8') as f:
            json.dump({**s, "trades": [asdict(t) for t in out["trades"]]}, f, indent=1, default=str)
        print(f"report: {stem}.md")
```

- [ ] **Step 2: Dry run against today's data**

Run: `cd scripts && python kalshi_ladder_replay.py`
Expected while the backfill is still running: `kalshi_ladder_replay: backfill incomplete (2025-26 rows missing stats: three_pointers, pra)` and exit code 1. That is the correct outcome now; the real run happens after the backfill (see "After merge").

- [ ] **Step 3: Commit**

```bash
git add scripts/kalshi_ladder_replay.py
git commit -m "feat(kalshi): full-ladder replay entry script"
```

---

### Task 9: Full verification and merge

- [ ] **Step 1: Run everything**

```bash
cd scripts && python -m pytest tests -q
```
```bash
npx tsc --noEmit
```
```bash
npx eslint .
```
```bash
npx vitest run
```
Expected: all pytest pass (211 + new), tsc clean, eslint 0 errors, all vitest pass (164 + new).

- [ ] **Step 2: Ask the user before merging**

Merging to `master` auto-deploys production. Ask, then on approval:

```bash
git checkout master && git pull --ff-only && git merge --ff-only feat/kalshi-full-ladder && git push origin master
```

Watch CI (`gh run watch <id> --exit-status`) and load `https://prizmproject.vercel.app/markets/performance` to confirm it renders with the "By kind" table. After the next `kalshi_live` run on a game day, confirm `kalshi_model_rungs` has today's rows and `kalshi_model_picks` gains `kind = 'stretched'` rows 30 minutes before tips.

---

## After merge (not code; for the session that runs the replay)

1. Wait for the PC backfill to finish (`.logs/kalshi-backfill.log`), then run the strike-fix SQL from the calibration-study notes.
2. `cd scripts && python kalshi_ladder_replay.py --report`; commit `docs/kalshi-study/<date>-full-ladder-replay.{md,json}` whatever the result.
3. PASS: one commit setting `STRETCHED_VISIBLE = true` in `lib/kalshi/model-picks.ts`. FAIL: leave it false; stretched picks stay paper on Performance.
4. Forward rule (any time): if graded `kind = 'stretched'` picks reach n >= 300 with ROI < 0, set `STRETCHED_VISIBLE = false`.
