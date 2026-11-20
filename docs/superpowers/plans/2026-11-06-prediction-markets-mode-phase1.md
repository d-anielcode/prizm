# Prediction Markets Mode, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Kalshi NBA player-prop ladders (points, rebounds, assists, threes, PRA, double-double, triple-double) into Supabase on the pipeline, and ship a `/markets` mode whose Props tab shows each rung's Kalshi price next to the player's actual hit rate at that rung.

**Architecture:** A Python pipeline step (reusing `scripts/kalshi_edges/market_data.py`) upserts one row per Kalshi ticker into a new `kalshi_markets` table; an overnight step writes settlement results. The Next.js app gets a `/markets/*` route tree with its own tabs and a mode toggle; `/markets/props` is a server component that reads `kalshi_markets` + `player_game_logs` and renders ladders using pure helpers in `lib/kalshi/ladder.ts`.

**Tech Stack:** Python 3 + requests + pytest (scripts/), Next.js 16 App Router + TypeScript + Supabase JS + Tailwind + vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-prediction-markets-mode-phase1-design.md`

**Repo:** `C:/Users/dcho0/nbaiqproject`, branch `master` (pushes auto-deploy to production, so push only after Task 10 verification passes).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20261106120000_kalshi_markets.sql` | create | table, index, keep-first trigger, RLS read policy |
| `scripts/kalshi_edges/market_data.py` | modify | colon-cut player names, DD/TD series map, `parse_market(raw, stat_map)`, `fetch_markets(status, min/max_close_ts)` |
| `scripts/kalshi_edges/ingest.py` | create | `to_row`, `collect`, `upsert_rows`, `settle_updates`, `apply_settlement` |
| `scripts/kalshi_ingest.py` | create | pipeline entry: ingest today's open markets |
| `scripts/kalshi_settle.py` | create | pipeline entry: settle yesterday's markets |
| `scripts/pipeline/phases.py` | modify | add `kalshi_ingest` (midday, pretip) and `kalshi_settle` (overnight) |
| `scripts/tests/test_kalshi_market_data.py` | modify | DD/TD parsing tests |
| `scripts/tests/test_kalshi_ingest.py` | create | row mapping + settlement tests |
| `scripts/tests/test_pipeline_phases.py` | modify | new step order |
| `lib/kalshi/ladder.ts` | create | fee, break-even, stat value, DD/TD, hit rate, ladder grouping |
| `lib/__tests__/kalshi-ladder.test.ts` | create | tests for the above |
| `lib/mode.ts` | create | mode from pathname, tab hrefs, counterpart path |
| `lib/__tests__/mode.test.ts` | create | tests for the above |
| `components/ModeToggle.tsx` | create | Sportsbook / Prediction Markets segmented toggle |
| `components/NavTabs.tsx` | modify | mode-aware hrefs |
| `components/MobileNav.tsx` | modify | mode-aware hrefs |
| `app/layout.tsx` | modify | render `ModeToggle` in the header |
| `components/MarketsPlaceholder.tsx` | create | "coming in phase N" card |
| `app/markets/page.tsx`, `app/markets/{feed,edge,trends,performance}/page.tsx` | create | placeholders |
| `app/markets/props/page.tsx` | create | data loading + filters |
| `components/MarketLadders.tsx` | create | ladder rendering (server component) |

---

### Task 1: `kalshi_markets` migration

**Files:**
- Create: `supabase/migrations/20261106120000_kalshi_markets.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Kalshi NBA player-prop markets, one row per ticker (Prediction Markets mode, phase 1).
-- Written only by the service role (pipeline steps kalshi_ingest / kalshi_settle);
-- read publicly by /markets pages. Idempotent. Apply in the Supabase SQL editor.
CREATE TABLE IF NOT EXISTS kalshi_markets (
  ticker        text PRIMARY KEY,
  series        text NOT NULL,
  stat          text NOT NULL,      -- points|rebounds|assists|three_pointers|pra|double_double|triple_double
  player        text NOT NULL,      -- as Kalshi spells it
  strike        int  NOT NULL,      -- N in "N+"; 1 for double_double / triple_double
  game_date     date,
  away          text,
  home          text,
  yes_bid       numeric,            -- 0..1, null when no bid
  yes_ask       numeric,            -- 0..1, null when no ask
  first_yes_ask numeric,            -- ask when first seen; kept by trigger
  volume        int  NOT NULL DEFAULT 0,
  status        text,
  result        text,               -- 'yes' / 'no' once finalized
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kalshi_markets_game_date_idx ON kalshi_markets (game_date);

-- Upserts always send first_yes_ask = current ask; keep the first one ever stored.
CREATE OR REPLACE FUNCTION kalshi_markets_keep_first() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.first_yes_ask := COALESCE(OLD.first_yes_ask, NEW.first_yes_ask);
  NEW.first_seen_at := OLD.first_seen_at;
  NEW.updated_at    := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS kalshi_markets_keep_first ON kalshi_markets;
CREATE TRIGGER kalshi_markets_keep_first BEFORE UPDATE ON kalshi_markets
  FOR EACH ROW EXECUTE FUNCTION kalshi_markets_keep_first();

ALTER TABLE kalshi_markets ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON kalshi_markets FROM anon, authenticated;
DROP POLICY IF EXISTS "anon_read" ON kalshi_markets;
CREATE POLICY "anon_read" ON kalshi_markets FOR SELECT TO anon, authenticated USING (true);
```

- [ ] **Step 2: Apply it**

The user applies migrations in the Supabase SQL editor (no direct DB access from this machine). Show the SQL to the user and ask them to run it. Then verify with the service key:

```bash
cd /c/Users/dcho0/nbaiqproject/scripts && python3 -c "
from pipeline.env import load_env_local; load_env_local()
import os, requests
u=os.environ['NEXT_PUBLIC_SUPABASE_URL'].rstrip('/')+'/rest/v1/kalshi_markets?select=ticker&limit=1'
k=os.environ['SUPABASE_SERVICE_KEY']
print(requests.get(u, headers={'apikey':k,'Authorization':'Bearer '+k}).status_code)"
```

Expected: `200`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261106120000_kalshi_markets.sql
git commit -m "feat(markets): kalshi_markets table"
```

---

### Task 2: Parse double-double / triple-double markets

**Files:**
- Modify: `scripts/kalshi_edges/market_data.py`
- Test: `scripts/tests/test_kalshi_market_data.py`

Live format (verified 2026-11-06): ticker `KXNBA2D-26NOV06MINNOP-MINTLYLES41`, title `"Trey Lyles: Double Double"`, `yes_sub_title` `"Trey Lyles"`, `floor_strike` 0.5, `strike_type` `"greater"`. Points titles look like `"LeBron James: 25+ points"`. Today `_extract_player` returns the whole DD title (4 tokens, passes the length check), so it must cut at the colon first. The scanner's `SERIES_STAT` / `PROP_SERIES` must NOT gain DD/TD (the paper ledger would start trading them).

- [ ] **Step 1: Write the failing tests** (append to `scripts/tests/test_kalshi_market_data.py`)

```python
from kalshi_edges.market_data import INGEST_SERIES_STAT, PROP_SERIES

def _dd(title="Trey Lyles: Double Double", series="KXNBA2D"):
    return {"ticker": f"{series}-26NOV06MINNOP-MINTLYLES41", "title": title,
            "yes_sub_title": "Trey Lyles", "floor_strike": 0.5, "strike_type": "greater",
            "yes_bid_dollars": "0.0300", "yes_ask_dollars": "0.0700", "volume_fp": "120"}

def test_colon_title_cuts_player_at_colon():
    raw = dict(sample_markets()[0]); raw["title"] = "LeBron James: 25+ points"
    assert parse_market(raw).player == "LeBron James"

def test_double_double_parses_with_ingest_map():
    kp = parse_market(_dd(), INGEST_SERIES_STAT)
    assert (kp.player, kp.stat, kp.strike, kp.yes_ask) == ("Trey Lyles", "double_double", 1, 0.07)
    assert (kp.game_date.isoformat(), kp.away, kp.home) == ("2026-11-06", "MIN", "NOP")

def test_triple_double_parses_with_ingest_map():
    kp = parse_market(_dd("Trey Lyles: Triple Double", "KXNBA3D"), INGEST_SERIES_STAT)
    assert kp.stat == "triple_double" and kp.strike == 1

def test_scanner_map_ignores_double_double():
    assert parse_market(_dd()) is None
    assert "KXNBA2D" not in PROP_SERIES and "KXNBA3D" not in PROP_SERIES

def test_ingest_map_is_the_seven_phase1_series():
    assert set(INGEST_SERIES_STAT.values()) == {
        "points", "rebounds", "assists", "three_pointers", "pra", "double_double", "triple_double"}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_kalshi_market_data.py -q`
Expected: ImportError on `INGEST_SERIES_STAT`.

- [ ] **Step 3: Implement**

In `market_data.py`, below `PROP_SERIES`, add:

```python
# Series the Prediction Markets mode ingests (phase 1). Separate from SERIES_STAT so
# the paper scanner keeps scanning only the book-anchored stats.
INGEST_SERIES_STAT = {
    "KXNBAPTS": "points", "KXNBAREB": "rebounds", "KXNBAAST": "assists",
    "KXNBA3PT": "three_pointers", "KXNBAPRA": "pra",
    "KXNBA2D": "double_double", "KXNBA3D": "triple_double",
}
```

In `_extract_player`, right after the `t = re.sub(...)` line, add the colon cut:

```python
    # Live titles are "<Player>: <milestone>" ("Trey Lyles: Double Double").
    if ":" in t:
        t = t.split(":", 1)[0]
```

Change `parse_market`'s signature and stat lookup:

```python
def parse_market(raw, stat_map=None):
    """Parse one Kalshi market dict into a KalshiProp, or None if not an NBA prop.
    stat_map: series ticker -> stat (default SERIES_STAT, the scanner's set)."""
    ticker = raw.get("ticker", "")
    series = _series_of(ticker)
    text = f"{raw.get('title') or ''} {raw.get('yes_sub_title') or ''}"
    smap = SERIES_STAT if stat_map is None else stat_map
    stat = smap.get(series) or (None if series in INGEST_SERIES_STAT else _classify_stat(text))
```

(The rest of `parse_market` is unchanged. The `series in INGEST_SERIES_STAT` guard stops a DD title from falling through to keyword classification under the scanner's map.)

Extend `fetch_markets` so settlement can read closed markets:

```python
def fetch_markets(series_ticker, session=None, status="open", min_close_ts=None, max_close_ts=None):
    """Page through markets for one series ticker. Returns raw market dicts.
    status: Kalshi filter ('open', 'closed', 'settled'); close_ts bounds are unix seconds."""
    sess = session or requests.Session()
    out, cursor = [], None
    while True:
        params = {"limit": 1000, "status": status, "series_ticker": series_ticker}
        if min_close_ts is not None:
            params["min_close_ts"] = int(min_close_ts)
        if max_close_ts is not None:
            params["max_close_ts"] = int(max_close_ts)
        if cursor:
            params["cursor"] = cursor
        data = _get(sess, f"{KALSHI_BASE}/markets", params=params).json()
        out.extend(data.get("markets", []))
        cursor = data.get("cursor")
        if not cursor:
            break
        time.sleep(PAGE_PAUSE_S)
    return out
```

- [ ] **Step 4: Run all Kalshi tests**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/ -q -k kalshi`
Expected: all pass (existing scanner tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/market_data.py scripts/tests/test_kalshi_market_data.py
git commit -m "feat(markets): parse Kalshi double-double/triple-double markets"
```

---

### Task 3: Ingest module

**Files:**
- Create: `scripts/kalshi_edges/ingest.py`
- Test: `scripts/tests/test_kalshi_ingest.py`

- [ ] **Step 1: Write the failing tests**

```python
from datetime import date
from kalshi_edges.ingest import to_row, collect, settle_updates
from kalshi_edges.market_data import KalshiProp

def _kp(**kw):
    base = dict(ticker="KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25", player="Anthony Edwards",
                stat="points", strike=25, yes_bid=0.44, yes_ask=0.46, volume=900,
                series="KXNBAPTS", game_date=date(2026, 11, 6), away="MIN", home="NOP")
    base.update(kw)
    return KalshiProp(**base)

def test_to_row_maps_fields():
    row = to_row(_kp(), status="active")
    assert row == {"ticker": "KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25", "series": "KXNBAPTS",
                   "stat": "points", "player": "Anthony Edwards", "strike": 25,
                   "game_date": "2026-11-06", "away": "MIN", "home": "NOP",
                   "yes_bid": 0.44, "yes_ask": 0.46, "first_yes_ask": 0.46,
                   "volume": 900, "status": "active"}

def test_to_row_empty_sides_become_null():
    row = to_row(_kp(yes_bid=0.0, yes_ask=1.0), status="active")
    assert row["yes_bid"] is None and row["yes_ask"] is None and row["first_yes_ask"] is None

def test_to_row_skips_missing_game():
    assert to_row(_kp(game_date=None), status="active") is None
    assert to_row(_kp(away=None), status="active") is None

def _raw(ticker, title, series, ask="0.4600", status="active", result=""):
    return {"ticker": ticker, "title": title, "floor_strike": 24.5, "strike_type": "greater",
            "yes_bid_dollars": "0.4400", "yes_ask_dollars": ask, "volume_fp": "900",
            "status": status, "result": result}

def test_collect_parses_and_counts_skips():
    raws = {"KXNBAPTS": [_raw("KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25", "Anthony Edwards: 25+ points", "KXNBAPTS"),
                         _raw("KXNBAPTS-BADTICKER", "Anthony Edwards: 25+ points", "KXNBAPTS"),
                         _raw("KXNBAPTS-26NOV06MINNOP-X", "garbage", "KXNBAPTS")]}
    rows, skipped = collect(lambda s: raws.get(s, []), series=["KXNBAPTS"])
    assert [r["ticker"] for r in rows] == ["KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25"]
    assert skipped == 2

def test_settle_updates_groups_by_result_for_one_date():
    raws = [_raw("KXNBAPTS-26NOV06MINNOP-A-25", "A B: 25+ points", "KXNBAPTS", status="finalized", result="yes"),
            _raw("KXNBAPTS-26NOV06MINNOP-C-30", "C D: 30+ points", "KXNBAPTS", status="finalized", result="no"),
            _raw("KXNBAPTS-26NOV07MINNOP-E-30", "E F: 30+ points", "KXNBAPTS", status="finalized", result="no"),
            _raw("KXNBAPTS-26NOV06MINNOP-G-35", "G H: 35+ points", "KXNBAPTS", status="closed", result="")]
    assert settle_updates(raws, date(2026, 11, 6)) == {
        ("finalized", "yes"): ["KXNBAPTS-26NOV06MINNOP-A-25"],
        ("finalized", "no"): ["KXNBAPTS-26NOV06MINNOP-C-30"],
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_kalshi_ingest.py -q`
Expected: ModuleNotFoundError `kalshi_edges.ingest`.

- [ ] **Step 3: Implement `scripts/kalshi_edges/ingest.py`**

```python
"""Kalshi -> kalshi_markets (Prediction Markets mode, phase 1).

collect() + to_row() are pure (tested); upsert_rows() / apply_settlement() do the
Supabase I/O with the service role. The table's BEFORE UPDATE trigger keeps
first_yes_ask / first_seen_at from the first insert, so every upsert can send them.
"""
import os
from datetime import date, datetime, time as dtime, timedelta, timezone

import requests

from kalshi_edges.market_data import (INGEST_SERIES_STAT, _game_of, fetch_markets,
                                      parse_market)

TABLE = "kalshi_markets"
PAGE = 500


def _side(v, empty):
    return None if v is None or v == empty else round(float(v), 4)


def to_row(kp, status):
    """KalshiProp -> table row, or None if the ticker has no game date / teams."""
    if kp.game_date is None or not kp.away or not kp.home:
        return None
    ask = _side(kp.yes_ask, 1.0)
    return {"ticker": kp.ticker, "series": kp.series, "stat": kp.stat, "player": kp.player,
            "strike": kp.strike, "game_date": kp.game_date.isoformat(),
            "away": kp.away, "home": kp.home,
            "yes_bid": _side(kp.yes_bid, 0.0), "yes_ask": ask, "first_yes_ask": ask,
            "volume": kp.volume, "status": status}


def collect(fetch, series=None):
    """fetch(series_ticker) -> raw market dicts. Returns (rows, skipped_count)."""
    rows, skipped = [], 0
    for s in (series or list(INGEST_SERIES_STAT)):
        for raw in fetch(s):
            kp = parse_market(raw, INGEST_SERIES_STAT)
            row = to_row(kp, raw.get("status") or "active") if kp else None
            if row is None:
                skipped += 1
            else:
                rows.append(row)
    return rows, skipped


def settle_updates(raws, game_date):
    """Finalized markets for game_date grouped as {(status, result): [tickers]}."""
    out = {}
    for raw in raws:
        gd, _, _ = _game_of(raw.get("ticker"))
        result = raw.get("result")
        if gd != game_date or raw.get("status") != "finalized" or result not in ("yes", "no"):
            continue
        out.setdefault(("finalized", result), []).append(raw["ticker"])
    return out


# ── Supabase I/O ─────────────────────────────────────────────────────────────
def _sb():
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def upsert_rows(rows):
    url, h = _sb()
    for i in range(0, len(rows), PAGE):
        r = requests.post(f"{url}/{TABLE}?on_conflict=ticker",
                          headers={**h, "Prefer": "resolution=merge-duplicates,return=minimal"},
                          json=rows[i:i + PAGE], timeout=60)
        r.raise_for_status()
    return len(rows)


def apply_settlement(updates):
    url, h = _sb()
    n = 0
    for (status, result), tickers in updates.items():
        for i in range(0, len(tickers), 100):
            chunk = tickers[i:i + 100]
            ids = ",".join(f'"{t}"' for t in chunk)
            r = requests.patch(f"{url}/{TABLE}?ticker=in.({ids})",
                               headers={**h, "Prefer": "return=minimal"},
                               json={"status": status, "result": result}, timeout=60)
            r.raise_for_status()
            n += len(chunk)
    return n


def run_ingest(session=None):
    sess = session or requests.Session()
    rows, skipped = collect(lambda s: fetch_markets(s, session=sess))
    return upsert_rows(rows), skipped


def run_settle(game_date, session=None):
    """Settle one ET game date: settled markets closing between that date and +2 days (UTC)."""
    sess = session or requests.Session()
    lo = datetime.combine(game_date, dtime(0), tzinfo=timezone.utc).timestamp()
    hi = lo + timedelta(days=2).total_seconds()
    raws = []
    for s in INGEST_SERIES_STAT:
        raws += fetch_markets(s, session=sess, status="settled", min_close_ts=lo, max_close_ts=hi)
    return apply_settlement(settle_updates(raws, game_date))
```

- [ ] **Step 4: Run tests**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_kalshi_ingest.py -q`
Expected: 5 passed. (`test_collect_parses_and_counts_skips`: the `BADTICKER` row parses but has no game → skipped; `garbage` has no strike match in title but has floor_strike, and its player `"garbage"` is 1 token → parse returns None → skipped.)

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/ingest.py scripts/tests/test_kalshi_ingest.py
git commit -m "feat(markets): Kalshi ingest + settlement module"
```

---

### Task 4: Pipeline entry scripts and steps

**Files:**
- Create: `scripts/kalshi_ingest.py`, `scripts/kalshi_settle.py`
- Modify: `scripts/pipeline/phases.py`
- Test: `scripts/tests/test_pipeline_phases.py`

Python steps run `python scripts/<target>` with `cwd=scripts/` and no arguments, so each entry script decides its own date. Steps go on their own chain `'kalshi'` so a Kalshi failure never skips props/enrich and vice versa.

- [ ] **Step 1: Update the phase tests** in `scripts/tests/test_pipeline_phases.py`

Replace `test_overnight_order` and `test_other_phases` with:

```python
def test_overnight_order():
    assert names('overnight') == [
        'gamelogs', 'grade', 'grade_wnba', 'feed_grade', 'results', 'seasonstats', 'perf_snapshot',
        'props', 'props_wnba', 'wnba_stats', 'sim_3pm', 'enrich', 'streak', 'parlay',
        'kalshi_settle', 'defense_fresh']

def test_other_phases():
    assert names('midday') == ['props', 'enrich', 'parlay_pass2', 'kalshi_ingest']
    assert names('pretip') == ['lineups', 'props', 'enrich', 'snapshot', 'kalshi_ingest']
    assert names('weekly') == ['player_bias', 'opponent_leaks']

def test_kalshi_steps_own_chain_not_critical():
    ks = [s for p in PHASES.values() for s in p if s.name.startswith('kalshi_')]
    assert len(ks) == 3
    assert all(s.chain == 'kalshi' and s.kind == 'python' and not s.critical for s in ks)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_pipeline_phases.py -q`
Expected: 3 failures.

- [ ] **Step 3: Add the steps** in `scripts/pipeline/phases.py`

In `'overnight'`, insert before the `defense_fresh` line:
```python
        Step('kalshi_settle', 'kalshi', 'python', 'kalshi_settle.py', -1),
```
Append to the end of `'midday'` and of `'pretip'`:
```python
        Step('kalshi_ingest', 'kalshi', 'python', 'kalshi_ingest.py', 0),
```

- [ ] **Step 4: Create `scripts/kalshi_ingest.py`**

```python
"""Pipeline step: upsert today's open Kalshi NBA player-prop markets into kalshi_markets."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.ingest import run_ingest  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    n, skipped = run_ingest()
    print(f'kalshi_ingest: upserted {n} markets, skipped {skipped}')
    sys.exit(0 if n > 0 or skipped == 0 else 1)
```

(Exit 1 only when everything was skipped, which means the parser broke. Zero markets with zero skips is a normal off-day.)

- [ ] **Step 5: Create `scripts/kalshi_settle.py`**

```python
"""Pipeline step: write yes/no results for yesterday's (ET) Kalshi markets."""
import os, sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.ingest import run_settle  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    d = datetime.now(ZoneInfo('America/New_York')).date() - timedelta(days=1)
    print(f'kalshi_settle {d}: settled {run_settle(d)} markets')
```

- [ ] **Step 6: Run the full Python suite**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/ -q`
Expected: all pass.

- [ ] **Step 7: Live smoke test (after Task 1's migration is applied)**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 kalshi_ingest.py`
Expected: `kalshi_ingest: upserted N markets, skipped M` with N in the hundreds on a game day and M small. Then:

Run: `python3 kalshi_settle.py`
Expected: `kalshi_settle <yesterday>: settled 0 markets` on the first run (yesterday's markets were never ingested). If Kalshi rejects `status=settled`, check the live API docs for the closed-market status value and adjust `run_settle`.

- [ ] **Step 8: Commit**

```bash
git add scripts/kalshi_ingest.py scripts/kalshi_settle.py scripts/pipeline/phases.py scripts/tests/test_pipeline_phases.py
git commit -m "feat(markets): kalshi_ingest/kalshi_settle pipeline steps"
```

---

### Task 5: Ladder helpers (`lib/kalshi/ladder.ts`)

**Files:**
- Create: `lib/kalshi/ladder.ts`
- Test: `lib/__tests__/kalshi-ladder.test.ts`

`player_game_logs` columns used: `player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes`. Threes are `fg3m`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import {
  kalshiFee, breakEven, isDoubleDouble, isTripleDouble, statValue, hitRate, groupLadders,
  type LadderLog, type MarketRow,
} from '@/lib/kalshi/ladder'

const log = (o: Partial<LadderLog>): LadderLog => ({
  game_date: '2026-11-01', points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0,
  fg3m: 0, pra: null, minutes: 30, ...o })

describe('fees', () => {
  it('fee is 0.07 p (1-p)', () => { expect(kalshiFee(0.5)).toBeCloseTo(0.0175) })
  it('break-even is ask plus fee', () => { expect(breakEven(0.4)).toBeCloseTo(0.4 + 0.07 * 0.4 * 0.6) })
})

describe('double / triple double', () => {
  it('counts any two of pts/reb/ast/stl/blk at 10+', () => {
    expect(isDoubleDouble(log({ points: 10, rebounds: 10 }))).toBe(true)
    expect(isDoubleDouble(log({ points: 25, blocks: 10 }))).toBe(true)
    expect(isDoubleDouble(log({ points: 30, rebounds: 9 }))).toBe(false)
  })
  it('triple needs three', () => {
    expect(isTripleDouble(log({ points: 10, rebounds: 10, assists: 10 }))).toBe(true)
    expect(isTripleDouble(log({ points: 30, rebounds: 15, assists: 9 }))).toBe(false)
  })
})

describe('statValue', () => {
  it('maps threes to fg3m and computes pra when null', () => {
    expect(statValue(log({ fg3m: 4 }), 'three_pointers')).toBe(4)
    expect(statValue(log({ points: 20, rebounds: 5, assists: 5 }), 'pra')).toBe(30)
    expect(statValue(log({ points: 20, rebounds: 5, assists: 5, pra: 31 }), 'pra')).toBe(31)
  })
  it('DD/TD are 1 or 0', () => {
    expect(statValue(log({ points: 10, assists: 10 }), 'double_double')).toBe(1)
    expect(statValue(log({ points: 10 }), 'triple_double')).toBe(0)
  })
})

describe('hitRate', () => {
  const logs = [ // newest first
    log({ game_date: '2026-11-05', points: 30 }),
    log({ game_date: '2026-11-03', points: 20 }),
    log({ game_date: '2026-11-01', points: 0, minutes: 0 }),   // DNP, ignored
    log({ game_date: '2026-04-10', points: 26 }),              // last season
  ]
  it('last-N uses played games only', () => {
    expect(hitRate(logs, 'points', 25, { last: 2 })).toEqual({ hits: 1, games: 2 })
    expect(hitRate(logs, 'points', 25, { last: 10 })).toEqual({ hits: 2, games: 3 })
  })
  it('season window filters by date', () => {
    expect(hitRate(logs, 'points', 25, { from: '2026-10-01', to: '2027-09-30' })).toEqual({ hits: 1, games: 2 })
  })
})

describe('groupLadders', () => {
  const row = (o: Partial<MarketRow>): MarketRow => ({
    ticker: 't', stat: 'points', player: 'A B', strike: 25, game_date: '2026-11-06',
    away: 'MIN', home: 'NOP', yes_bid: 0.4, yes_ask: 0.42, first_yes_ask: 0.42,
    volume: 10, status: 'active', updated_at: '2026-11-06T20:00:00Z', ...o })
  it('groups game -> player -> stat with rungs ascending', () => {
    const g = groupLadders([
      row({ ticker: 'a30', strike: 30 }), row({ ticker: 'a20', strike: 20 }),
      row({ ticker: 'b', player: 'C D', stat: 'rebounds', strike: 8 }),
      row({ ticker: 'c', away: 'BOS', home: 'CHA', player: 'E F' }),
    ])
    expect(g.map((x) => x.key)).toEqual(['BOS@CHA', 'MIN@NOP'])
    const min = g[1]
    expect(min.players.map((p) => p.player)).toEqual(['A B', 'C D'])
    expect(min.players[0].stats[0].rungs.map((r) => r.strike)).toEqual([20, 30])
  })
  it('orders stats in display order', () => {
    const g = groupLadders([row({ ticker: 'x', stat: 'double_double', strike: 1 }), row({ ticker: 'y', stat: 'points' })])
    expect(g[0].players[0].stats.map((s) => s.stat)).toEqual(['points', 'double_double'])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/kalshi-ladder.test.ts`
Expected: fails to resolve `@/lib/kalshi/ladder`.

- [ ] **Step 3: Implement `lib/kalshi/ladder.ts`**

```ts
// Pure helpers for the Prediction Markets Props tab (Kalshi "N+" ladders).

export const MARKET_STATS = [
  'points', 'rebounds', 'assists', 'three_pointers', 'pra', 'double_double', 'triple_double',
] as const
export type MarketStat = (typeof MARKET_STATS)[number]

export const STAT_LABEL: Record<MarketStat, string> = {
  points: 'Points', rebounds: 'Rebounds', assists: 'Assists', three_pointers: 'Threes',
  pra: 'Pts+Reb+Ast', double_double: 'Double-double', triple_double: 'Triple-double',
}

export interface MarketRow {
  ticker: string
  stat: MarketStat
  player: string
  strike: number
  game_date: string
  away: string
  home: string
  yes_bid: number | null
  yes_ask: number | null
  first_yes_ask: number | null
  volume: number
  status: string | null
  updated_at: string
}

export interface LadderLog {
  game_date: string
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  fg3m: number
  pra: number | null
  minutes: number | null
}

/** Kalshi taker fee per contract at price p (0..1), before per-order cent rounding. */
export function kalshiFee(p: number): number {
  return 0.07 * p * (1 - p)
}

/** Probability the YES side must hit to break even buying at `ask`. */
export function breakEven(ask: number): number {
  return ask + kalshiFee(ask)
}

function tens(l: LadderLog): number {
  return [l.points, l.rebounds, l.assists, l.steals, l.blocks].filter((v) => (v ?? 0) >= 10).length
}
export const isDoubleDouble = (l: LadderLog) => tens(l) >= 2
export const isTripleDouble = (l: LadderLog) => tens(l) >= 3

export function statValue(l: LadderLog, stat: MarketStat): number {
  switch (stat) {
    case 'points': return l.points
    case 'rebounds': return l.rebounds
    case 'assists': return l.assists
    case 'three_pointers': return l.fg3m
    case 'pra': return l.pra ?? l.points + l.rebounds + l.assists
    case 'double_double': return isDoubleDouble(l) ? 1 : 0
    case 'triple_double': return isTripleDouble(l) ? 1 : 0
  }
}

export interface HitRate { hits: number; games: number }

/** Hit rate of "strike+" over played games (minutes > 0). `logs` must be newest first.
 *  Window: { last: n } = most recent n played games; { from, to } = inclusive dates. */
export function hitRate(
  logs: LadderLog[], stat: MarketStat, strike: number,
  window: { last: number } | { from: string; to: string },
): HitRate {
  let played = logs.filter((l) => (l.minutes ?? 0) > 0)
  played = 'last' in window
    ? played.slice(0, window.last)
    : played.filter((l) => l.game_date >= window.from && l.game_date <= window.to)
  return { hits: played.filter((l) => statValue(l, stat) >= strike).length, games: played.length }
}

export interface StatLadder { stat: MarketStat; rungs: MarketRow[] }
export interface PlayerLadders { player: string; stats: StatLadder[] }
export interface GameLadders { key: string; away: string; home: string; players: PlayerLadders[] }

/** game ("AWY@HOM", sorted) -> player (sorted) -> stat (MARKET_STATS order) -> rungs (strike asc). */
export function groupLadders(rows: MarketRow[]): GameLadders[] {
  const games = new Map<string, Map<string, MarketRow[]>>()
  for (const r of rows) {
    const key = `${r.away}@${r.home}`
    if (!games.has(key)) games.set(key, new Map())
    const players = games.get(key)!
    if (!players.has(r.player)) players.set(r.player, [])
    players.get(r.player)!.push(r)
  }
  return [...games.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, players]) => {
    const [away, home] = key.split('@')
    return {
      key, away, home,
      players: [...players.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([player, rs]) => ({
        player,
        stats: MARKET_STATS
          .map((stat) => ({ stat, rungs: rs.filter((r) => r.stat === stat).sort((a, b) => a.strike - b.strike) }))
          .filter((s) => s.rungs.length > 0),
      })),
    }
  })
}
```

- [ ] **Step 4: Run tests**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/kalshi-ladder.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/kalshi/ladder.ts lib/__tests__/kalshi-ladder.test.ts
git commit -m "feat(markets): ladder helpers (fee, break-even, DD/TD, hit rates, grouping)"
```

---

### Task 6: Mode helpers (`lib/mode.ts`)

**Files:**
- Create: `lib/mode.ts`
- Test: `lib/__tests__/mode.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { modeOf, tabHref, counterpartPath } from '@/lib/mode'

describe('mode', () => {
  it('detects markets mode by prefix', () => {
    expect(modeOf('/markets')).toBe('markets')
    expect(modeOf('/markets/props')).toBe('markets')
    expect(modeOf('/marketsx')).toBe('sportsbook')
    expect(modeOf('/props')).toBe('sportsbook')
  })
  it('prefixes tab hrefs in markets mode', () => {
    expect(tabHref('/', 'markets')).toBe('/markets')
    expect(tabHref('/props', 'markets')).toBe('/markets/props')
    expect(tabHref('/props', 'sportsbook')).toBe('/props')
  })
  it('maps a page to its counterpart in the other mode', () => {
    expect(counterpartPath('/props')).toBe('/markets/props')
    expect(counterpartPath('/')).toBe('/markets')
    expect(counterpartPath('/markets/edge')).toBe('/edge')
    expect(counterpartPath('/markets')).toBe('/')
    expect(counterpartPath('/player/LeBron%20James')).toBe('/markets')
    expect(counterpartPath('/status')).toBe('/markets')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/mode.test.ts`
Expected: fails to resolve `@/lib/mode`.

- [ ] **Step 3: Implement `lib/mode.ts`**

```ts
// Sportsbook mode lives at the existing routes; Prediction Markets mode under /markets.
export type Mode = 'sportsbook' | 'markets'

export const MARKETS_PREFIX = '/markets'
/** Tabs that exist in both modes (sportsbook paths). */
export const SHARED_TABS = ['/', '/feed', '/edge', '/trends', '/props', '/performance'] as const

export function modeOf(pathname: string): Mode {
  return pathname === MARKETS_PREFIX || pathname.startsWith(`${MARKETS_PREFIX}/`) ? 'markets' : 'sportsbook'
}

/** A sportsbook tab href as it appears in `mode`. */
export function tabHref(href: string, mode: Mode): string {
  if (mode === 'sportsbook') return href
  return href === '/' ? MARKETS_PREFIX : `${MARKETS_PREFIX}${href}`
}

/** Same tab in the other mode; pages without a counterpart go to the other mode's home. */
export function counterpartPath(pathname: string): string {
  if (modeOf(pathname) === 'markets') {
    const rest = pathname.slice(MARKETS_PREFIX.length) || '/'
    return (SHARED_TABS as readonly string[]).includes(rest) ? rest : '/'
  }
  return (SHARED_TABS as readonly string[]).includes(pathname) ? tabHref(pathname, 'markets') : MARKETS_PREFIX
}
```

- [ ] **Step 4: Run tests**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/mode.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/mode.ts lib/__tests__/mode.test.ts
git commit -m "feat(markets): mode routing helpers"
```

---

### Task 7: Mode toggle and mode-aware navigation

**Files:**
- Create: `components/ModeToggle.tsx`
- Modify: `components/NavTabs.tsx`, `components/MobileNav.tsx`, `app/layout.tsx`

- [ ] **Step 1: Create `components/ModeToggle.tsx`**

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { modeOf, counterpartPath, type Mode } from '@/lib/mode'

const LABEL: Record<Mode, string> = { sportsbook: 'Sportsbook', markets: 'Prediction Markets' }

export function ModeToggle() {
  const pathname = usePathname()
  const mode = modeOf(pathname)
  const other = counterpartPath(pathname)
  return (
    <div className="flex items-center rounded-full border border-white/10 p-0.5 text-xs font-semibold">
      {(['sportsbook', 'markets'] as const).map((m) =>
        m === mode ? (
          <span key={m} aria-current="page" className="rounded-full bg-primary/20 px-3 py-1 text-[var(--text-primary)]">
            {LABEL[m]}
          </span>
        ) : (
          <Link key={m} href={other} className="rounded-full px-3 py-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
            {LABEL[m]}
          </Link>
        ),
      )}
    </div>
  )
}
```

- [ ] **Step 2: Make `components/NavTabs.tsx` mode-aware**

Replace the import block, `TABS`, and the start of the component with:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { modeOf, tabHref } from '@/lib/mode'

const TABS = [
  { label: 'Home',        href: '/' },
  { label: 'Feed',        href: '/feed' },
  { label: 'Edge',        href: '/edge' },
  { label: 'Trends',      href: '/trends' },
  { label: 'Props',       href: '/props' },
  { label: 'Performance', href: '/performance' },
  { label: 'Status',      href: '/status' },
]

export function NavTabs() {
  const pathname = usePathname()
  const mode = modeOf(pathname)

  return (
    <nav className="hidden sm:flex items-center">
      {TABS.map(({ label, href: base }) => {
        // Status is shared by both modes (one pipeline), so it keeps its own path.
        const href = base === '/status' ? base : tabHref(base, mode)
        const isActive = href === '/' || href === '/markets' ? pathname === href : pathname.startsWith(href)
```

The JSX below (`<Link key={href} href={href} ...>`) stays unchanged; `href` is now the mode-aware value.

- [ ] **Step 3: Make `components/MobileNav.tsx` mode-aware**

Add `import { modeOf, tabHref } from '@/lib/mode'` after the `usePathname` import (line 4). Then replace lines 70 and 76-77:

```tsx
  const pathname = usePathname()
  const mode = modeOf(pathname)
```

```tsx
        {TABS.map(({ label, href: base, icon }) => {
          const href = base === '/status' ? base : tabHref(base, mode)
          const isActive = href === '/' || href === '/markets' ? pathname === href : pathname.startsWith(href)
```

The rest of the callback (`key={href}`, `href={href}`, classes) stays unchanged.

- [ ] **Step 4: Render the toggle in `app/layout.tsx`**

Add `import { ModeToggle } from '@/components/ModeToggle'`. Replace the right-side block:

```tsx
            {/* Mode toggle + search — right */}
            <div className="shrink-0 flex items-center gap-3">
              <div className="hidden md:block"><ModeToggle /></div>
              <HeaderSearch />
            </div>
```

And above `<MobileNav />`'s sibling `<main>`, inside `<main ...>` before `{children}`, add a small-screen toggle:

```tsx
          <div className="md:hidden flex justify-center pt-3"><ModeToggle /></div>
```

- [ ] **Step 5: Typecheck and lint**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit && npx eslint app components lib types middleware.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/ModeToggle.tsx components/NavTabs.tsx components/MobileNav.tsx app/layout.tsx
git commit -m "feat(markets): Sportsbook / Prediction Markets toggle and mode-aware nav"
```

---

### Task 8: Markets placeholder tabs

**Files:**
- Create: `components/MarketsPlaceholder.tsx`, `app/markets/page.tsx`, `app/markets/feed/page.tsx`, `app/markets/edge/page.tsx`, `app/markets/trends/page.tsx`, `app/markets/performance/page.tsx`

- [ ] **Step 1: Create `components/MarketsPlaceholder.tsx`**

```tsx
import Link from 'next/link'

export function MarketsPlaceholder({ title, phase, blurb }: { title: string; phase: number; blurb: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
      <h1 className="mt-2 text-2xl font-bold text-[var(--text-primary)]">{title}</h1>
      <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <p className="text-sm text-[var(--text-secondary)]">{blurb}</p>
        <p className="mt-3 text-xs text-[var(--text-tertiary)]">Coming in phase {phase}.</p>
      </div>
      <Link href="/markets/props" className="mt-6 inline-block text-sm font-semibold text-primary">
        See today&apos;s Kalshi ladders →
      </Link>
    </div>
  )
}
```

- [ ] **Step 2: Create the five pages**

`app/markets/page.tsx`:
```tsx
import { MarketsPlaceholder } from '@/components/MarketsPlaceholder'
export default function MarketsHome() {
  return <MarketsPlaceholder title="Home" phase={3}
    blurb="Today's Kalshi slate at a glance: biggest price moves and the rungs our model rates highest once it is validated." />
}
```
`app/markets/feed/page.tsx`:
```tsx
import { MarketsPlaceholder } from '@/components/MarketsPlaceholder'
export default function MarketsFeed() {
  return <MarketsPlaceholder title="Feed" phase={3} blurb="Curated Kalshi picks and combos, built from the validated per-rung model." />
}
```
`app/markets/edge/page.tsx`:
```tsx
import { MarketsPlaceholder } from '@/components/MarketsPlaceholder'
export default function MarketsEdge() {
  return <MarketsPlaceholder title="Edge" phase={2} blurb="Model probability vs Kalshi break-even for every rung, shown only after the model beats the market on settled Kalshi results." />
}
```
`app/markets/trends/page.tsx`:
```tsx
import { MarketsPlaceholder } from '@/components/MarketsPlaceholder'
export default function MarketsTrends() {
  return <MarketsPlaceholder title="Trends" phase={3} blurb="Hit-rate streaks at Kalshi rungs, including double-double and triple-double runs." />
}
```
`app/markets/performance/page.tsx`:
```tsx
import { MarketsPlaceholder } from '@/components/MarketsPlaceholder'
export default function MarketsPerformance() {
  return <MarketsPlaceholder title="Performance" phase={4} blurb="Results graded from Kalshi settlement: ROI at real prices and closing-line value." />
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/MarketsPlaceholder.tsx app/markets
git commit -m "feat(markets): placeholder tabs for markets mode"
```

---

### Task 9: `/markets/props` page

**Files:**
- Create: `app/markets/props/page.tsx`, `components/MarketLadders.tsx`

- [ ] **Step 1: Create `components/MarketLadders.tsx`**

```tsx
import { breakEven, STAT_LABEL, type GameLadders, type HitRate, type MarketStat } from '@/lib/kalshi/ladder'
import { normalizeTeamAbbr } from '@/lib/team-abbr'

export type RungRates = { l5: HitRate; l10: HitRate; season: HitRate } | null
export type RatesFor = (player: string, stat: MarketStat, strike: number) => RungRates

const cents = (p: number | null) => (p == null ? '—' : `${Math.round(p * 100)}¢`)
const pct = (p: number) => `${Math.round(p * 100)}%`
const frac = (h: HitRate) => (h.games ? `${h.hits}/${h.games}` : '—')

function rungLabel(stat: MarketStat, strike: number) {
  return stat === 'double_double' ? 'DD' : stat === 'triple_double' ? 'TD' : `${strike}+`
}

export function MarketLadders({ games, ratesFor }: { games: GameLadders[]; ratesFor: RatesFor }) {
  return (
    <div className="space-y-8">
      {games.map((g) => (
        <section key={g.key}>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            {normalizeTeamAbbr(g.away) ?? g.away} @ {normalizeTeamAbbr(g.home) ?? g.home}
          </h2>
          <div className="space-y-4">
            {g.players.map((p) => (
              <div key={p.player} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <h3 className="font-semibold text-[var(--text-primary)]">{p.player}</h3>
                {p.stats.map((s) => (
                  <div key={s.stat} className="mt-3 overflow-x-auto">
                    <p className="mb-1 text-xs font-semibold text-[var(--text-secondary)]">{STAT_LABEL[s.stat]}</p>
                    <table className="w-full min-w-[520px] text-xs tabular-nums">
                      <thead className="text-[var(--text-tertiary)]">
                        <tr className="text-left">
                          <th className="py-1 pr-3">Rung</th><th className="pr-3">Bid / Ask</th>
                          <th className="pr-3">Break-even</th><th className="pr-3">Move</th>
                          <th className="pr-3">L5</th><th className="pr-3">L10</th><th>Season</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.rungs.map((r) => {
                          const rates = ratesFor(p.player, s.stat, r.strike)
                          const wide = r.yes_bid == null || r.yes_ask == null || r.yes_ask - r.yes_bid > 0.10
                          const move = r.yes_ask != null && r.first_yes_ask != null ? r.yes_ask - r.first_yes_ask : 0
                          return (
                            <tr key={r.ticker} className={`border-t border-white/5 ${wide ? 'opacity-40' : ''}`}>
                              <td className="py-1 pr-3 font-semibold text-[var(--text-primary)]">{rungLabel(s.stat, r.strike)}</td>
                              <td className="pr-3">{cents(r.yes_bid)} / {cents(r.yes_ask)}</td>
                              <td className="pr-3">{r.yes_ask == null ? '—' : pct(breakEven(r.yes_ask))}</td>
                              <td className={`pr-3 ${move > 0 ? 'text-emerald-400' : move < 0 ? 'text-red-400' : 'text-[var(--text-tertiary)]'}`}>
                                {move > 0 ? '▲' : move < 0 ? '▼' : '·'}{move ? ` ${Math.abs(Math.round(move * 100))}¢` : ''}
                              </td>
                              {rates ? (
                                <>
                                  <td className="pr-3">{frac(rates.l5)}</td>
                                  <td className="pr-3">{frac(rates.l10)}</td>
                                  <td>{frac(rates.season)}{rates.season.games ? ` (${pct(rates.season.hits / rates.season.games)})` : ''}</td>
                                </>
                              ) : (
                                <td colSpan={3} className="text-[var(--text-tertiary)]">no history</td>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create `app/markets/props/page.tsx`**

```tsx
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { CURRENT_SEASON } from '@/lib/constants'
import { seasonDateRange, shiftSeason } from '@/lib/season'
import { playerNameVariants } from '@/lib/player-aliases'
import { normalizePlayerName } from '@/lib/lineups'
import {
  groupLadders, hitRate, MARKET_STATS, STAT_LABEL, type LadderLog, type MarketRow, type MarketStat,
} from '@/lib/kalshi/ladder'
import { MarketLadders, type RatesFor } from '@/components/MarketLadders'

export const dynamic = 'force-dynamic'

const PAGE = 1000
const STALE_MS = 90 * 60 * 1000

async function loadMarkets(gameDate: string): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('kalshi_markets')
      .select('ticker, stat, player, strike, game_date, away, home, yes_bid, yes_ask, first_yes_ask, volume, status, updated_at')
      .eq('game_date', gameDate).in('stat', [...MARKET_STATS])
      .order('ticker').range(from, from + PAGE - 1)
    if (error) { console.error('[markets/props]', error.message); break }
    out.push(...((data ?? []) as MarketRow[]))
    if (!data || data.length < PAGE) break
  }
  return out
}

type LogRow = LadderLog & { player_name: string }

async function loadLogs(players: string[]): Promise<Map<string, LadderLog[]>> {
  const names = [...new Set(players.flatMap(playerNameVariants))]
  const since = seasonDateRange(shiftSeason(CURRENT_SEASON, -1)).start
  const rows: LogRow[] = []
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('player_game_logs')
        .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
        .in('player_name', batch).gte('game_date', since)
        .order('game_date', { ascending: false }).range(from, from + PAGE - 1)
      if (error) { console.error('[markets/props] logs', error.message); break }
      rows.push(...((data ?? []) as LogRow[]))
      if (!data || data.length < PAGE) break
    }
  }
  const byKey = new Map<string, LadderLog[]>()
  for (const r of rows) {
    const k = normalizePlayerName(r.player_name)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(r)
  }
  for (const logs of byKey.values()) logs.sort((a, b) => b.game_date.localeCompare(a.game_date))
  return byKey
}

export default async function MarketsProps({ searchParams }: { searchParams: Promise<{ stat?: string; game?: string }> }) {
  const { stat, game } = await searchParams
  const now = new Date()
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const all = await loadMarkets(today)
  const statFilter = (MARKET_STATS as readonly string[]).includes(stat ?? '') ? (stat as MarketStat) : null
  const rows = all.filter((r) => (!statFilter || r.stat === statFilter) && (!game || `${r.away}@${r.home}` === game))
  const games = groupLadders(rows)
  const gameKeys = [...new Set(all.map((r) => `${r.away}@${r.home}`))].sort()

  const logs = await loadLogs([...new Set(rows.map((r) => r.player))])
  const season = seasonDateRange(CURRENT_SEASON)
  const ratesFor: RatesFor = (player, s, strike) => {
    const l = logs.get(normalizePlayerName(player))
    if (!l?.length) return null
    return {
      l5: hitRate(l, s, strike, { last: 5 }),
      l10: hitRate(l, s, strike, { last: 10 }),
      season: hitRate(l, s, strike, { from: season.start, to: season.end }),
    }
  }

  const newest = all.reduce<string | null>((m, r) => (!m || r.updated_at > m ? r.updated_at : m), null)
  const stale = newest != null && now.getTime() - new Date(newest).getTime() > STALE_MS
  const asOf = newest && new Date(newest).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
  const href = (q: { stat?: string | null; game?: string | null }) => {
    const p = new URLSearchParams()
    const s = q.stat === undefined ? statFilter : q.stat
    const g = q.game === undefined ? game : q.game
    if (s) p.set('stat', s)
    if (g) p.set('game', g)
    const qs = p.toString()
    return `/markets/props${qs ? `?${qs}` : ''}`
  }
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-semibold ${active ? 'bg-primary/20 text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
      <h1 className="mt-1 text-2xl font-bold text-[var(--text-primary)]">Kalshi player props</h1>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        {asOf ? `Prices as of ${asOf} ET` : 'No prices yet today'}
        {stale && <span className="ml-2 text-[#FFB800]">Prices may be stale</span>}
        {' · '}Break-even includes Kalshi&apos;s fee. Hit rates count games played at or above the rung.
      </p>

      <div className="mt-5 flex flex-wrap gap-1">
        <Link href={href({ stat: null })} className={chip(!statFilter)}>All stats</Link>
        {MARKET_STATS.map((s) => <Link key={s} href={href({ stat: s })} className={chip(statFilter === s)}>{STAT_LABEL[s]}</Link>)}
      </div>
      {gameKeys.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Link href={href({ game: null })} className={chip(!game)}>All games</Link>
          {gameKeys.map((g) => <Link key={g} href={href({ game: g })} className={chip(game === g)}>{g.replace('@', ' @ ')}</Link>)}
        </div>
      )}

      <div className="mt-6">
        {games.length === 0
          ? <p className="text-sm text-[var(--text-secondary)]">No Kalshi player props listed for today yet.</p>
          : <MarketLadders games={games} ratesFor={ratesFor} />}
      </div>
    </div>
  )
}
```

Note: `ratesFor` is a function passed from a server component to `MarketLadders`, which is also a server component (no `'use client'`), so this is allowed.

- [ ] **Step 3: Typecheck, lint, tests, build**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit && npx eslint app components lib types middleware.ts && npx vitest run`
Expected: no errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add app/markets/props/page.tsx components/MarketLadders.tsx
git commit -m "feat(markets): Kalshi Props tab with ladders and hit rates"
```

---

### Task 10: Verify end to end, then ship

- [ ] **Step 1: Full local checks (same as CI)**

```bash
cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit && npx eslint app components lib types middleware.ts && npx vitest run && (cd scripts && python3 -m pytest tests -q)
```
Expected: everything passes.

- [ ] **Step 2: Data present**

Run `python3 scripts/kalshi_ingest.py` from the repo (Task 4 Step 7) if not already done today.

- [ ] **Step 3: Preview**

Start the dev server with the preview tool (`preview_start`, name from `.claude/launch.json`). Check:
1. `/markets/props` lists today's games, players, ladders; DD/TD rows show "DD"/"TD".
2. Spot-check one player: count their last 10 played games at a rung by hand from `player_game_logs` and compare with the L10 cell.
3. Stat and game filter chips change the URL and the rows.
4. Toggle on `/props` goes to `/markets/props` and back; on `/player/...` goes to `/markets`.
5. Nav tabs in markets mode point at `/markets/*`; Status stays `/status`.
6. `/props`, `/edge`, `/` render exactly as before.
7. No console errors (`read_console_messages`), mobile width (375px) has no horizontal page scroll except inside ladder tables.

Take a screenshot of `/markets/props` as proof.

- [ ] **Step 4: Push (auto-deploys to production)**

Only with the user's go-ahead:
```bash
git push origin master
```
Then confirm production: `https://prizmproject.vercel.app/markets/props` renders, and after the next pretip run `/status` shows a `kalshi_ingest` row with status ok.

- [ ] **Step 5: Next day**

Check `/status` for `kalshi_settle` ok, and that yesterday's `kalshi_markets` rows have `result` filled.
