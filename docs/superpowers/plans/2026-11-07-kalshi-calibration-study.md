# Kalshi Calibration Study (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill every settled Kalshi NBA player-prop market (Nov 2025 onward) with its pre-tip price, run a pre-registered calibration study over 176 fixed pockets, forward paper-trade pockets that pass, and show the evidence on `/markets/edge`.

**Architecture:** Pure Python modules in `scripts/kalshi_edges/` (`teams`, `espn`, `history`, `study`, `pockets_live`) with thin entry scripts run by the existing pipeline (`scripts/pipeline/phases.py`). Data lives in four new Supabase tables written with the service role. The Next.js Edge tab reads those tables with the anon key; it never re-implements the classifier.

**Tech Stack:** Python 3 + requests + scipy + pytest; Next.js 16 / TypeScript / Supabase JS / vitest; Supabase MCP for migrations.

**Spec:** `docs/superpowers/specs/2026-11-07-kalshi-calibration-study-design.md`

**Repo:** `C:/Users/dcho0/nbaiqproject`. Work on branch `feat/kalshi-study`. Pushing `master` auto-deploys production; merge only after Task 11.

## Verified API facts (2026-11-07)

- Settled markets, last season: `GET /historical/markets?series_ticker=S&limit=1000&cursor=` (no status filter needed; all are finalized). Raw dicts have `ticker`, `open_time`, `close_time`, `result` (`yes`/`no`/`scalar`), `yes_ask_dollars`, `title`, `floor_strike`, `strike_type`.
- Settled markets, this season: `GET /markets?series_ticker=S&status=settled&limit=1000&cursor=` (existing `market_data.fetch_markets(s, status="settled")`).
- Candles, historical: `GET /historical/markets/{ticker}/candlesticks?start_ts&end_ts&period_interval=60` → `{"candlesticks":[{"end_period_ts":int, "volume":"0.00", "yes_ask":{"close":"0.1400",...}, "yes_bid":{"close":"0.0500",...}}]}`.
- Candles, live: `GET /series/{series}/markets/{ticker}/candlesticks?...` → same shape but `close_dollars` and `volume_fp`.
- No usable batch candle endpoint (`/markets/candlesticks` returned `{"markets":[]}`).
- ESPN: `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD` → `events[].date` ("2026-06-14T00:30Z"), `events[].competitions[0].competitors[]` with `homeAway` and `team.abbreviation` (ESPN codes: NY, SA, GS, NO, UTAH, WSH).
- Kalshi ticker game segment, e.g. `26JUN13NYKSAS` → date + concatenated team codes (`NYKSAS`).

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261107120000_kalshi_study.sql` | 4 tables + grants + RLS |
| `scripts/kalshi_edges/teams.py` | team-code canonicalization, ticker team string |
| `scripts/kalshi_edges/espn.py` | ESPN tip times → index by every spelling of "AWYHOM" |
| `scripts/kalshi_edges/history.py` | pre-tip candle selection, settled-row building, backfill orchestration + I/O |
| `scripts/kalshi_edges/study.py` | trades, ladder position, pockets, stats, bars, calibration, report |
| `scripts/kalshi_edges/pockets_live.py` | live pocket scan + grading (pure + I/O) |
| `scripts/kalshi_edges/sb.py` | shared Supabase REST helpers (select-all paging, upsert, insert-ignore, patch) |
| `scripts/kalshi_backfill.py`, `kalshi_study.py`, `kalshi_pocket_scan.py`, `kalshi_pocket_grade.py` | entry scripts |
| `scripts/kalshi_settle.py` | modify: also writes `kalshi_settled` rows |
| `scripts/pipeline/phases.py` | add 3 steps |
| `scripts/tests/test_kalshi_{teams,espn,history,study,pockets_live}.py`, `test_pipeline_phases.py` | tests |
| `lib/kalshi/edge.ts` + `lib/__tests__/kalshi-edge.test.ts` | chart scaling, pocket labels |
| `app/markets/edge/page.tsx`, `components/CalibrationChart.tsx` | Edge tab |

Run Python tests with `cd scripts && python3 -m pytest tests -q`. Run TS checks with `npx tsc --noEmit && npx eslint app components lib && npx vitest run`. Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Migration (controller applies via Supabase MCP)

**Files:** Create `supabase/migrations/20261107120000_kalshi_study.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Prediction Markets phase 2a: Kalshi calibration study tables.
-- Written by the service role (backfill, study, pocket scan/grade); read publicly by /markets/edge.
-- New tables on this project get no API grants by default, so grants are explicit.

CREATE TABLE IF NOT EXISTS kalshi_settled (
  ticker          text PRIMARY KEY,
  series          text NOT NULL,
  stat            text NOT NULL,
  player          text NOT NULL,
  strike          int  NOT NULL,
  game_date       date NOT NULL,
  away            text,
  home            text,
  season          text NOT NULL,
  tip_time        timestamptz NOT NULL,
  open_time       timestamptz NOT NULL,
  pretip_yes_bid  numeric,
  pretip_yes_ask  numeric,
  pretip_volume   numeric NOT NULL DEFAULT 0,
  result          text NOT NULL,          -- yes | no | void
  backfilled_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kalshi_settled_game_date_idx ON kalshi_settled (game_date);

CREATE TABLE IF NOT EXISTS kalshi_pockets (
  id          text PRIMARY KEY,
  side        text NOT NULL,
  definition  jsonb NOT NULL,
  disc_n      int, disc_roi numeric, disc_roi_h1 numeric, disc_roi_h2 numeric, disc_p numeric,
  conf_n      int, conf_roi numeric,
  fwd_n       int, fwd_roi numeric,
  status      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kalshi_calibration (
  season     text NOT NULL,
  band       text NOT NULL,
  n          int NOT NULL,
  mean_ask   numeric NOT NULL,
  yes_rate   numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season, band)
);

CREATE TABLE IF NOT EXISTS kalshi_pocket_trades (
  id         bigserial PRIMARY KEY,
  pocket_id  text NOT NULL,
  ticker     text NOT NULL,
  side       text NOT NULL,
  price      numeric NOT NULL,
  fee        numeric NOT NULL,
  game_date  date NOT NULL,
  logged_at  timestamptz NOT NULL DEFAULT now(),
  result     text,
  won        boolean,
  pnl        numeric,
  UNIQUE (pocket_id, ticker, side)
);
CREATE INDEX IF NOT EXISTS kalshi_pocket_trades_game_date_idx ON kalshi_pocket_trades (game_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kalshi_settled','kalshi_pockets','kalshi_calibration','kalshi_pocket_trades'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO service_role', t);
    EXECUTE format('GRANT SELECT ON %I TO anon, authenticated', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "anon_read" ON %I', t);
    EXECUTE format('CREATE POLICY "anon_read" ON %I FOR SELECT TO anon, authenticated USING (true)', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON SEQUENCE kalshi_pocket_trades_id_seq TO service_role;
```

- [ ] **Step 2: Apply** with the Supabase MCP `apply_migration` (project `shvoyqofsbtnzwokuutt`, name `kalshi_study`), then verify with `execute_sql`: `select relname, relacl::text from pg_class where relname like 'kalshi_%' and relkind='r';` — each new table shows `service_role=arwd...` and `anon=r...`.

- [ ] **Step 3: Commit** `git add supabase/migrations/20261107120000_kalshi_study.sql && git commit -m "feat(study): kalshi study tables"`

---

### Task 2: Team codes and ESPN tip times

**Files:** Create `scripts/kalshi_edges/teams.py`, `scripts/kalshi_edges/espn.py`; Test `scripts/tests/test_kalshi_teams.py`, `scripts/tests/test_kalshi_espn.py`

- [ ] **Step 1: Failing tests**

`scripts/tests/test_kalshi_teams.py`:
```python
from kalshi_edges.teams import canon, spellings, ticker_teams

def test_canon_maps_espn_and_variants():
    assert canon("NY") == "NYK" and canon("SA") == "SAS" and canon("GS") == "GSW"
    assert canon("UTAH") == "UTA" and canon("WSH") == "WAS" and canon("NO") == "NOP"
    assert canon("bos") == "BOS"

def test_spellings_include_canonical_and_aliases():
    s = spellings("NY")
    assert {"NY", "NYK"} <= s

def test_ticker_teams():
    assert ticker_teams("KXNBAPTS-26JUN13NYKSAS-SASVWEMBANYAMA1-40") == "NYKSAS"
    assert ticker_teams("BAD") is None
```

`scripts/tests/test_kalshi_espn.py`:
```python
from datetime import datetime, timezone
from kalshi_edges.espn import tip_index

SCOREBOARD = {"events": [
    {"date": "2026-06-14T00:30Z", "competitions": [{"competitors": [
        {"homeAway": "home", "team": {"abbreviation": "SA"}},
        {"homeAway": "away", "team": {"abbreviation": "NY"}}]}]},
]}

def test_tip_index_matches_kalshi_spelling():
    idx = tip_index(SCOREBOARD)
    tip = datetime(2026, 6, 14, 0, 30, tzinfo=timezone.utc)
    assert idx["NYKSAS"] == tip
    assert idx["NYSA"] == tip
    assert "SASNYK" not in idx          # order is away+home
```

- [ ] **Step 2: Run** `cd scripts && python3 -m pytest tests/test_kalshi_teams.py tests/test_kalshi_espn.py -q` → ImportError.

- [ ] **Step 3: Implement**

`scripts/kalshi_edges/teams.py`:
```python
"""NBA team-code canonicalization across ESPN, odds feeds and Kalshi tickers."""
import re

_ALIASES = {
    "GS": "GSW", "NO": "NOP", "NY": "NYK", "SA": "SAS", "UTAH": "UTA", "UTH": "UTA",
    "WSH": "WAS", "NJ": "BKN", "BRK": "BKN", "PHO": "PHX", "CHO": "CHA",
}
_REVERSE = {}
for a, c in _ALIASES.items():
    _REVERSE.setdefault(c, set()).add(a)


def canon(code):
    c = (code or "").upper()
    return _ALIASES.get(c, c)


def spellings(code):
    """Every spelling a team may appear under (canonical + known aliases)."""
    c = canon(code)
    return {c, (code or "").upper()} | _REVERSE.get(c, set())


_GAME_RE = re.compile(r"^\d{2}[A-Z]{3}\d{2}([A-Z]+)$")


def ticker_teams(ticker):
    """'KXNBAPTS-26JUN13NYKSAS-...' -> 'NYKSAS' (away+home as Kalshi spells them)."""
    parts = (ticker or "").split("-")
    if len(parts) < 2:
        return None
    m = _GAME_RE.match(parts[1])
    return m.group(1) if m else None
```

`scripts/kalshi_edges/espn.py`:
```python
"""ESPN scoreboard tip times, indexed by every 'AWAYHOME' spelling a Kalshi ticker may use."""
from datetime import datetime
import requests

from kalshi_edges.teams import spellings

SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"


def _parse_dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def tip_index(scoreboard):
    """{away_spelling + home_spelling: tip datetime (UTC)} for every spelling pair."""
    out = {}
    for ev in scoreboard.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        side = {c.get("homeAway"): c.get("team", {}).get("abbreviation") for c in comp.get("competitors", [])}
        if not side.get("away") or not side.get("home") or not ev.get("date"):
            continue
        tip = _parse_dt(ev["date"])
        for a in spellings(side["away"]):
            for h in spellings(side["home"]):
                out[a + h] = tip
    return out


def fetch_tip_index(game_date, session=None):
    """game_date: datetime.date (ET game date). Returns tip_index for that date."""
    sess = session or requests.Session()
    r = sess.get(SCOREBOARD, params={"dates": game_date.strftime("%Y%m%d")}, timeout=30)
    r.raise_for_status()
    return tip_index(r.json())
```

- [ ] **Step 4: Run tests** → pass.
- [ ] **Step 5: Commit** `git add scripts/kalshi_edges/teams.py scripts/kalshi_edges/espn.py scripts/tests/test_kalshi_teams.py scripts/tests/test_kalshi_espn.py && git commit -m "feat(study): team codes + ESPN tip times"`

---

### Task 3: Shared Supabase helpers

**Files:** Create `scripts/kalshi_edges/sb.py`; Test `scripts/tests/test_kalshi_sb.py`

- [ ] **Step 1: Failing test**

```python
from kalshi_edges import sb

class FakeResp:
    def __init__(self, data): self._d = data; self.status_code = 200
    def raise_for_status(self): pass
    def json(self): return self._d

def test_select_all_pages_until_short(monkeypatch):
    monkeypatch.setattr(sb, "_sb", lambda: ("U", {}))
    pages = [[{"i": i} for i in range(1000)], [{"i": 1000}]]
    calls = []
    def get(url, headers=None, timeout=None):
        calls.append(headers["Range"]); return FakeResp(pages[len(calls) - 1])
    monkeypatch.setattr(sb.requests, "get", get)
    rows = sb.select_all("t", "select=i&order=i")
    assert len(rows) == 1001 and calls == ["0-999", "1000-1999"]
```

- [ ] **Step 2: Run** → ImportError.
- [ ] **Step 3: Implement** `scripts/kalshi_edges/sb.py`:

```python
"""Minimal Supabase REST helpers (service role) for the Kalshi study scripts."""
import os
import requests

PAGE = 1000


def _sb():
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def select_all(table, query):
    """All rows for `table?query`, paged with Range headers. Query must include a unique order."""
    url, h = _sb()
    out, start = [], 0
    while True:
        r = requests.get(f"{url}/{table}?{query}", headers={**h, "Range": f"{start}-{start + PAGE - 1}"}, timeout=60)
        r.raise_for_status()
        rows = r.json()
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        start += PAGE


def upsert(table, rows, on_conflict, page=500):
    url, h = _sb()
    for i in range(0, len(rows), page):
        r = requests.post(f"{url}/{table}?on_conflict={on_conflict}",
                          headers={**h, "Prefer": "resolution=merge-duplicates,return=minimal"},
                          json=rows[i:i + page], timeout=60)
        r.raise_for_status()
    return len(rows)


def insert_ignore(table, rows, on_conflict):
    """Insert, skipping rows that hit the unique key. Returns rows actually inserted."""
    if not rows:
        return 0
    url, h = _sb()
    r = requests.post(f"{url}/{table}?on_conflict={on_conflict}&select=id",
                      headers={**h, "Prefer": "resolution=ignore-duplicates,return=representation"},
                      json=rows, timeout=60)
    r.raise_for_status()
    return len(r.json())


def patch(table, query, fields):
    url, h = _sb()
    r = requests.patch(f"{url}/{table}?{query}", headers={**h, "Prefer": "return=minimal"}, json=fields, timeout=60)
    r.raise_for_status()
```

- [ ] **Step 4: Run** → pass. **Step 5: Commit** `feat(study): shared Supabase REST helpers`.

---

### Task 4: Pre-tip candle selection and settled rows (pure)

**Files:** Create `scripts/kalshi_edges/history.py` (pure part); Test `scripts/tests/test_kalshi_history.py`

- [ ] **Step 1: Failing tests**

```python
from datetime import date, datetime, timezone
from kalshi_edges.history import pretip_from_candles, season_of, settled_row, RESULT_MAP

TIP = 1781397000  # 2026-06-14T00:30Z

def c_hist(end, ask, bid, vol):
    return {"end_period_ts": end, "volume": vol, "yes_ask": {"close": ask}, "yes_bid": {"close": bid}}

def c_live(end, ask, bid, vol):
    return {"end_period_ts": end, "volume_fp": vol, "yes_ask": {"close_dollars": ask}, "yes_bid": {"close_dollars": bid}}

def test_last_candle_at_or_before_tip_both_formats():
    for c in (c_hist, c_live):
        candles = [c(TIP - 7200, "0.30", "0.25", "10.00"), c(TIP - 3600, "0.40", "0.35", "5.00"),
                   c(TIP, "0.42", "0.38", "1.00"), c(TIP + 3600, "0.90", "0.80", "99.00")]
        assert pretip_from_candles(candles, TIP) == (0.38, 0.42, 16.0)

def test_empty_sides_become_none():
    assert pretip_from_candles([c_hist(TIP - 60, "1.0000", "0.0000", "0")], TIP) is None
    assert pretip_from_candles([c_hist(TIP - 60, "0.0000", "0.0500", "0")], TIP) == (0.05, None, 0.0)

def test_no_candle_before_tip():
    assert pretip_from_candles([c_hist(TIP + 1, "0.4", "0.3", "1")], TIP) is None

def test_season_of():
    assert season_of(date(2026, 6, 13)) == "2025-26"
    assert season_of(date(2026, 10, 1)) == "2026-27"

def test_settled_row():
    raw = {"ticker": "KXNBAPTS-26JUN13NYKSAS-SASVWEMBANYAMA1-40", "title": "Victor Wembanyama: 40+ points",
           "floor_strike": 39.5, "strike_type": "greater", "yes_ask_dollars": "1.0000",
           "open_time": "2026-06-11T04:10:00Z", "result": "no"}
    tip = datetime(2026, 6, 14, 0, 30, tzinfo=timezone.utc)
    row = settled_row(raw, tip, (0.05, 0.14, 0.0))
    assert row == {"ticker": raw["ticker"], "series": "KXNBAPTS", "stat": "points",
                   "player": "Victor Wembanyama", "strike": 40, "game_date": "2026-06-13",
                   "away": "NYK", "home": "SAS", "season": "2025-26",
                   "tip_time": "2026-06-14T00:30:00+00:00", "open_time": "2026-06-11T04:10:00+00:00",
                   "pretip_yes_bid": 0.05, "pretip_yes_ask": 0.14, "pretip_volume": 0.0, "result": "no"}

def test_result_map():
    assert RESULT_MAP == {"yes": "yes", "no": "no", "scalar": "void"}
```

- [ ] **Step 2: Run** → ImportError.
- [ ] **Step 3: Implement** `scripts/kalshi_edges/history.py` (pure section):

```python
"""Settled Kalshi markets with pre-tip prices -> kalshi_settled (phase 2a study).

Pure helpers first (tested); backfill orchestration + I/O below.
"""
from datetime import date, datetime

from kalshi_edges.market_data import INGEST_SERIES_STAT, parse_market

RESULT_MAP = {"yes": "yes", "no": "no", "scalar": "void"}
SEASON_START = (10, 1)   # Oct 1


def _num(v):
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _close(c, side):
    d = c.get(side) or {}
    return _num(d.get("close_dollars", d.get("close")))


def pretip_from_candles(candles, tip_ts):
    """(bid, ask, volume_before_tip) from the last candle ending at or before tip.
    bid <= 0 and ask <= 0 or >= 1 count as empty sides; None if no candle or both empty."""
    before = [c for c in candles if int(c.get("end_period_ts", 0)) <= tip_ts]
    if not before:
        return None
    last = max(before, key=lambda c: int(c["end_period_ts"]))
    bid, ask = _close(last, "yes_bid"), _close(last, "yes_ask")
    bid = bid if bid is not None and bid > 0 else None
    ask = ask if ask is not None and 0 < ask < 1 else None
    if bid is None and ask is None:
        return None
    vol = sum(_num(c.get("volume_fp", c.get("volume"))) or 0.0 for c in before)
    return (bid, ask, vol)


def season_of(d):
    y = d.year if (d.month, d.day) >= SEASON_START else d.year - 1
    return f"{y}-{str(y + 1)[-2:]}"


def _dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def settled_row(raw, tip, pretip):
    """kalshi_settled row from a settled raw market, its tip time and pretip tuple; None if unparseable."""
    kp = parse_market(raw, INGEST_SERIES_STAT)
    result = RESULT_MAP.get(raw.get("result"))
    if kp is None or kp.game_date is None or result is None:
        return None
    from kalshi_edges.teams import canon
    bid, ask, vol = pretip
    return {"ticker": kp.ticker, "series": kp.series, "stat": kp.stat, "player": kp.player,
            "strike": kp.strike, "game_date": kp.game_date.isoformat(),
            "away": canon(kp.away) if kp.away else None, "home": canon(kp.home) if kp.home else None,
            "season": season_of(kp.game_date), "tip_time": tip.isoformat(),
            "open_time": _dt(raw["open_time"]).isoformat(),
            "pretip_yes_bid": bid, "pretip_yes_ask": ask, "pretip_volume": vol, "result": result}
```

Move the `canon` import to the top of the file once tests pass (kept inline above only to show the dependency).

- [ ] **Step 4: Run** → pass. **Step 5: Commit** `feat(study): pre-tip candle selection and settled rows`.

---

### Task 5: Backfill orchestration + entry script

**Files:** Modify `scripts/kalshi_edges/history.py` (append); Create `scripts/kalshi_backfill.py`; Test append to `scripts/tests/test_kalshi_history.py`

- [ ] **Step 1: Failing tests** (append)

```python
from kalshi_edges.history import process_markets, BackfillStats

def _raw(t, open_time="2026-06-13T20:00:00Z", result="no"):
    return {"ticker": t, "title": "Victor Wembanyama: 40+ points", "floor_strike": 39.5,
            "strike_type": "greater", "yes_ask_dollars": "1.0000", "open_time": open_time, "result": result}

def test_process_markets_filters_and_counts():
    tip = datetime(2026, 6, 14, 0, 30, tzinfo=timezone.utc)
    raws = [
        _raw("KXNBAPTS-26JUN13NYKSAS-A-40"),                                       # ok
        _raw("KXNBAPTS-26JUN13NYKSAS-B-40", open_time="2026-06-14T01:00:00Z"),     # opened after tip
        _raw("KXNBAPTS-26JUN13BOSLAL-C-40"),                                       # no tip match
        _raw("KXNBAPTS-26JUN13NYKSAS-D-40"),                                       # already stored
        _raw("KXNBAPTS-26JUN13NYKSAS-E-40", result="unknown"),                     # bad result
    ]
    stats = BackfillStats()
    rows = process_markets(
        raws, tips_for=lambda d: {"NYKSAS": tip}, candles_for=lambda raw, s, e: [c_hist(TIP - 60, "0.14", "0.05", "2")],
        existing={"KXNBAPTS-26JUN13NYKSAS-D-40"}, stats=stats)
    assert [r["ticker"] for r in rows] == ["KXNBAPTS-26JUN13NYKSAS-A-40"]
    assert (stats.ok, stats.after_tip, stats.no_tip, stats.existing, stats.unparseable) == (1, 1, 1, 1, 1)

def test_no_tip_share_guard():
    s = BackfillStats(ok=7, no_tip=3)
    assert s.no_tip_share() == 0.3
```

- [ ] **Step 2: Run** → ImportError.
- [ ] **Step 3: Implement** (append to `history.py`; add imports `import sys, time`, `from dataclasses import dataclass`, `import requests`, `from kalshi_edges.market_data import KALSHI_BASE, _get, fetch_markets, _game_of`, `from kalshi_edges.teams import ticker_teams`, `from kalshi_edges.espn import fetch_tip_index`, `from kalshi_edges import sb` at the top):

```python
@dataclass
class BackfillStats:
    ok: int = 0
    existing: int = 0
    after_tip: int = 0
    no_tip: int = 0
    no_quote: int = 0
    unparseable: int = 0
    errors: int = 0

    def no_tip_share(self):
        seen = self.ok + self.after_tip + self.no_tip + self.no_quote
        return self.no_tip / seen if seen else 0.0


def process_markets(raws, tips_for, candles_for, existing, stats):
    """Build kalshi_settled rows. tips_for(date)->{teams: tip}; candles_for(raw, start_ts, end_ts)->candles."""
    rows = []
    for raw in raws:
        t = raw.get("ticker")
        if t in existing:
            stats.existing += 1
            continue
        gd, _, _ = _game_of(t)
        teams = ticker_teams(t)
        if gd is None or teams is None or RESULT_MAP.get(raw.get("result")) is None or not raw.get("open_time"):
            stats.unparseable += 1
            continue
        tip = tips_for(gd).get(teams)
        if tip is None:
            stats.no_tip += 1
            continue
        opened = _dt(raw["open_time"])
        if opened >= tip:
            stats.after_tip += 1
            continue
        try:
            pre = pretip_from_candles(candles_for(raw, int(opened.timestamp()), int(tip.timestamp())), int(tip.timestamp()))
        except requests.RequestException:
            stats.errors += 1
            continue
        if pre is None:
            stats.no_quote += 1
            continue
        row = settled_row(raw, tip, pre)
        if row is None:
            stats.unparseable += 1
            continue
        rows.append(row)
        stats.ok += 1
    return rows


THROTTLE_S = 0.12   # ~8 requests/s


def list_historical(series, session):
    out, cursor = [], None
    while True:
        params = {"series_ticker": series, "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        data = _get(session, f"{KALSHI_BASE}/historical/markets", params=params).json()
        out.extend(data.get("markets", []))
        cursor = data.get("cursor")
        if not cursor or not data.get("markets"):
            return out
        time.sleep(THROTTLE_S)


def candles_fetcher(session, historical):
    def fetch(raw, start_ts, end_ts):
        t = raw["ticker"]
        url = (f"{KALSHI_BASE}/historical/markets/{t}/candlesticks" if historical
               else f"{KALSHI_BASE}/series/{t.split('-')[0]}/markets/{t}/candlesticks")
        time.sleep(THROTTLE_S)
        return _get(session, url, params={"start_ts": start_ts, "end_ts": end_ts, "period_interval": 60}).json().get("candlesticks", [])
    return fetch


def tips_cache(session):
    cache = {}
    def tips_for(d):
        if d not in cache:
            cache[d] = fetch_tip_index(d, session)
            time.sleep(THROTTLE_S)
        return cache[d]
    return tips_for


def existing_tickers():
    return {r["ticker"] for r in sb.select_all("kalshi_settled", "select=ticker&order=ticker")}


def backfill(series_list=None, sources=("historical", "live"), session=None, log=print):
    """Backfill kalshi_settled. Resumable (skips stored tickers). Raises if >20% of a
    series is skipped for no tip-time match (team-code mapping is wrong)."""
    sess = session or requests.Session()
    existing = existing_tickers()
    tips_for = tips_cache(sess)
    total = BackfillStats()
    for series in (series_list or list(INGEST_SERIES_STAT)):
        for src in sources:
            raws = list_historical(series, sess) if src == "historical" else fetch_markets(series, session=sess, status="settled")
            stats = BackfillStats()
            buf = []
            for i in range(0, len(raws), 200):
                buf += process_markets(raws[i:i + 200], tips_for, candles_fetcher(sess, src == "historical"), existing, stats)
                if len(buf) >= 500:
                    sb.upsert("kalshi_settled", buf, "ticker"); existing |= {r["ticker"] for r in buf}; buf = []
                log(f"{series} {src}: {min(i + 200, len(raws))}/{len(raws)} {stats}")
                if stats.ok + stats.no_tip >= 200 and stats.no_tip_share() > 0.2:
                    raise RuntimeError(f"{series} {src}: {stats.no_tip_share():.0%} no tip match - fix team codes")
            if buf:
                sb.upsert("kalshi_settled", buf, "ticker"); existing |= {r["ticker"] for r in buf}
            for k, v in vars(stats).items():
                setattr(total, k, getattr(total, k) + v)
    return total
```

`scripts/kalshi_backfill.py`:
```python
"""One-time (resumable) backfill of settled Kalshi player-prop markets with pre-tip prices.
Usage: python kalshi_backfill.py [SERIES ...] [--live-only]"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges.history import backfill  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    sources = ('live',) if '--live-only' in sys.argv else ('historical', 'live')
    total = backfill(args or None, sources=sources, log=lambda m: print(m, flush=True))
    print(f'kalshi_backfill done: {total}')
```

- [ ] **Step 4: Run tests** → pass.
- [ ] **Step 5: Live smoke (small, writes to DB):** `cd scripts && python3 kalshi_backfill.py KXNBA3D --live-only` → prints progress and `ok=` > 0 with `no_tip` share under 20%. Then via Supabase MCP: `select season, count(*), count(pretip_yes_ask) from kalshi_settled group by 1;`.
- [ ] **Step 6: Commit** `feat(study): resumable backfill of settled markets`.

---

### Task 6: Study core (pure)

**Files:** Create `scripts/kalshi_edges/study.py`; Test `scripts/tests/test_kalshi_study.py`

- [ ] **Step 1: Failing tests**

```python
from kalshi_edges.study import (POCKET_IDS, band_of, build_trades, classify, pocket_stats,
                                discovery_pass, status_of, calibration, K)

def row(t, player="A B", stat="points", strike=20, bid=0.40, ask=0.42, vol=50, result="yes",
        gd="2025-12-01", season="2025-26"):
    return {"ticker": t, "player": player, "stat": stat, "strike": strike, "pretip_yes_bid": bid,
            "pretip_yes_ask": ask, "pretip_volume": vol, "result": result, "game_date": gd, "season": season}

def test_pocket_count_is_preregistered():
    assert K == len(POCKET_IDS) == 176

def test_band_edges():
    assert band_of(0.02) == ".02-.05" and band_of(0.0499) == ".02-.05"
    assert band_of(0.05) == ".05-.10" and band_of(0.98) == ".90-.98"
    assert band_of(0.01) is None and band_of(0.99) is None

def test_build_trades_sides_fees_pnl_and_position():
    rows = [row("a", strike=15), row("b", strike=20, result="no"), row("c", strike=25),
            row("d", stat="double_double", strike=1, bid=None, ask=0.30)]
    tr = {(t.ticker, t.side): t for t in build_trades(rows)}
    yes_b = tr[("b", "yes")]
    assert yes_b.price == 0.42 and yes_b.won is False
    assert abs(yes_b.pnl - -(0.42 + 0.07 * 0.42 * 0.58)) < 1e-9
    no_b = tr[("b", "no")]
    assert abs(no_b.price - 0.60) < 1e-9 and no_b.won is True
    assert tr[("a", "yes")].pos == "lowest" and yes_b.pos == "interior" and tr[("c", "yes")].pos == "top"
    assert tr[("d", "yes")].pos == "lowest" and ("d", "no") not in tr     # no bid -> no NO trade
    assert tr[("d", "yes")].spread == ">10"

def test_void_and_out_of_range_skipped():
    assert build_trades([row("v", result="void")]) == []
    assert [t.side for t in build_trades([row("x", bid=0.985, ask=0.99)])] == []

def test_classify_ids():
    t = build_trades([row("a", bid=0.07, ask=0.08, vol=0)])
    yes = next(x for x in t if x.side == "yes")
    assert classify(yes) == ["yes|band:.05-.10", "yes|stat:points", "yes|pos:lowest",
                             "yes|spread:<=3", "yes|vol:0", "yes|band:.05-.10|stat:points"]
    assert set(classify(yes)) <= set(POCKET_IDS)

def test_pocket_stats_halves_and_day_clustered_p():
    trades = build_trades([row(f"t{i}", gd=f"2025-12-{1 + i % 20:02d}", bid=0.10, ask=0.12,
                               result="no") for i in range(40)])
    no = [t for t in trades if t.side == "no"]          # all winners at .90
    s = pocket_stats(no)
    assert s["n"] == 40 and s["roi"] > 0 and s["roi_h1"] > 0 and s["roi_h2"] > 0 and s["p"] < 1e-6

def test_bars_and_status():
    good = {"n": 400, "roi": 0.05, "roi_h1": 0.04, "roi_h2": 0.06, "p": 1e-5}
    assert discovery_pass(good)
    assert not discovery_pass({**good, "p": 0.01})            # fails Bonferroni 0.05/176
    assert not discovery_pass({**good, "roi_h2": -0.01})
    assert status_of(good, {"n": 50, "roi": 0.1}, {"n": 0, "roi": 0}) == "discovery_pass"
    assert status_of(good, {"n": 120, "roi": -0.01}, {"n": 0, "roi": 0}) == "failed_confirmation"
    assert status_of(good, {"n": 120, "roi": 0.0}, {"n": 10, "roi": 0}) == "confirmed"
    assert status_of(good, {"n": 120, "roi": 0.0}, {"n": 300, "roi": 0.03}) == "live"
    assert status_of(good, {"n": 120, "roi": 0.0}, {"n": 300, "roi": 0.02}) == "failed_forward"
    assert status_of({**good, "n": 10}, {"n": 0, "roi": 0}, {"n": 0, "roi": 0}) == "rejected"

def test_calibration_rows():
    rows = [row("a", ask=0.12, result="yes"), row("b", ask=0.14, result="no"), row("c", ask=0.50, season="2026-27")]
    cal = {(c["season"], c["band"]): c for c in calibration(rows)}
    assert cal[("2025-26", ".10-.20")]["n"] == 2 and cal[("2025-26", ".10-.20")]["yes_rate"] == 0.5
    assert abs(cal[("2025-26", ".10-.20")]["mean_ask"] - 0.13) < 1e-9
```

- [ ] **Step 2: Run** → ImportError.
- [ ] **Step 3: Implement** `scripts/kalshi_edges/study.py`:

```python
"""Pre-registered Kalshi calibration study (spec 2026-11-07). Pure functions.

Pockets, bands and bars are fixed by the spec; do not edit after seeing results.
"""
from collections import defaultdict
from dataclasses import dataclass

from scipy import stats as sstats

from kalshi_edges.fees import taker_fee

BANDS = [(.02, .05), (.05, .10), (.10, .20), (.20, .35), (.35, .50), (.50, .65), (.65, .80), (.80, .90), (.90, .98)]
BAND_LABELS = [f"{lo:.2f}-{hi:.2f}".replace("0.", ".") for lo, hi in BANDS]
STATS = ["points", "rebounds", "assists", "three_pointers", "pra", "double_double", "triple_double"]
POSITIONS = ["lowest", "interior", "top"]
SPREADS = ["<=3", "4-10", ">10"]
VOLUMES = ["0", "1-99", "100+"]
SIDES = ["yes", "no"]
SINGLE_RUNG = {"double_double", "triple_double"}

POCKET_IDS = (
    [f"{s}|band:{b}" for s in SIDES for b in BAND_LABELS]
    + [f"{s}|stat:{x}" for s in SIDES for x in STATS]
    + [f"{s}|pos:{x}" for s in SIDES for x in POSITIONS]
    + [f"{s}|spread:{x}" for s in SIDES for x in SPREADS]
    + [f"{s}|vol:{x}" for s in SIDES for x in VOLUMES]
    + [f"{s}|band:{b}|stat:{x}" for s in SIDES for b in BAND_LABELS for x in STATS]
)
K = len(POCKET_IDS)
ALPHA = 0.05 / 176

DISC_MIN_N, DISC_MIN_ROI = 300, 0.03
CONF_MIN_N = 100
FWD_MIN_N, FWD_MIN_ROI = 300, 0.03


def band_of(p):
    for (lo, hi), label in zip(BANDS, BAND_LABELS):
        if lo <= p < hi or (hi == .98 and p == .98):
            return label
    return None


@dataclass
class Trade:
    ticker: str
    game_date: str
    season: str
    side: str
    price: float
    fee: float
    won: bool | None
    pnl: float | None
    stat: str
    pos: str
    spread: str
    vol: str


def _f(v):
    return None if v is None else float(v)


def _positions(rows):
    ladders = defaultdict(list)
    for r in rows:
        ladders[(r["game_date"], r["player"], r["stat"])].append(int(r["strike"]))
    pos = {}
    for r in rows:
        strikes = ladders[(r["game_date"], r["player"], r["stat"])]
        s = int(r["strike"])
        if r["stat"] in SINGLE_RUNG or len(strikes) == 1 or s == min(strikes):
            pos[r["ticker"]] = "lowest"
        elif s == max(strikes):
            pos[r["ticker"]] = "top"
        else:
            pos[r["ticker"]] = "interior"
    return pos


def _spread_tier(bid, ask):
    if bid is None or ask is None:
        return ">10"
    c = round((ask - bid) * 100)
    return "<=3" if c <= 3 else "4-10" if c <= 10 else ">10"


def _vol_tier(v):
    v = v or 0
    return "0" if v <= 0 else "1-99" if v < 100 else "100+"


def build_trades(rows, require_result=True):
    """One trade per priced side. Rows use kalshi_settled column names (live scans map
    kalshi_markets onto them). With require_result=False, unsettled rows give won/pnl None."""
    rows = [r for r in rows if r.get("result") != "void"]
    pos = _positions([r for r in rows if r.get("pretip_yes_ask") is not None or r.get("pretip_yes_bid") is not None])
    out = []
    for r in rows:
        res = r.get("result")
        if require_result and res not in ("yes", "no"):
            continue
        bid, ask = _f(r.get("pretip_yes_bid")), _f(r.get("pretip_yes_ask"))
        common = dict(ticker=r["ticker"], game_date=str(r["game_date"]), season=r.get("season", ""),
                      stat=r["stat"], pos=pos.get(r["ticker"], "lowest"),
                      spread=_spread_tier(bid, ask), vol=_vol_tier(_f(r.get("pretip_volume"))))
        for side, price in (("yes", ask), ("no", None if bid is None else 1 - bid)):
            if price is None or band_of(price) is None:
                continue
            fee = taker_fee(price)
            won = None if res not in ("yes", "no") else (res == side)
            pnl = None if won is None else (1 - price - fee if won else -(price + fee))
            out.append(Trade(side=side, price=price, fee=fee, won=won, pnl=pnl, **common))
    return out


def classify(t):
    b = band_of(t.price)
    return [f"{t.side}|band:{b}", f"{t.side}|stat:{t.stat}", f"{t.side}|pos:{t.pos}",
            f"{t.side}|spread:{t.spread}", f"{t.side}|vol:{t.vol}", f"{t.side}|band:{b}|stat:{t.stat}"]


def _roi(ts):
    staked = sum(t.price + t.fee for t in ts)
    return sum(t.pnl for t in ts) / staked if staked else 0.0


def pocket_stats(trades):
    ts = sorted(trades, key=lambda t: (t.game_date, t.ticker, t.side))
    n = len(ts)
    days = defaultdict(float)
    for t in ts:
        days[t.game_date] += t.pnl
    daily = list(days.values())
    if len(daily) >= 2 and len(set(daily)) > 1:
        p = float(sstats.ttest_1samp(daily, 0.0, alternative="greater").pvalue)
    elif len(daily) >= 2 and daily[0] > 0:
        p = 0.0
    else:
        p = 1.0
    return {"n": n, "roi": _roi(ts), "roi_h1": _roi(ts[: n // 2]), "roi_h2": _roi(ts[n // 2:]), "p": p}


def discovery_pass(d):
    return (d["n"] >= DISC_MIN_N and d["roi"] >= DISC_MIN_ROI and d["roi_h1"] > 0
            and d["roi_h2"] > 0 and d["p"] < ALPHA)


def status_of(disc, conf, fwd):
    if not discovery_pass(disc):
        return "rejected"
    if conf["n"] < CONF_MIN_N:
        return "discovery_pass"
    if conf["roi"] < 0:
        return "failed_confirmation"
    if fwd["n"] >= FWD_MIN_N:
        return "live" if fwd["roi"] >= FWD_MIN_ROI else "failed_forward"
    return "confirmed"


def by_pocket(trades):
    out = defaultdict(list)
    for t in trades:
        for pid in classify(t):
            out[pid].append(t)
    return out


def calibration(rows):
    acc = defaultdict(lambda: [0, 0.0, 0])
    for r in rows:
        ask = _f(r.get("pretip_yes_ask"))
        if ask is None or r.get("result") not in ("yes", "no"):
            continue
        b = band_of(ask)
        if b is None:
            continue
        a = acc[(r["season"], b)]
        a[0] += 1; a[1] += ask; a[2] += r["result"] == "yes"
    return [{"season": s, "band": b, "n": n, "mean_ask": tot / n, "yes_rate": y / n}
            for (s, b), (n, tot, y) in sorted(acc.items())]


def definition(pid):
    parts = pid.split("|")
    return {"side": parts[0], **{k: v for k, v in (p.split(":", 1) for p in parts[1:])}}
```

- [ ] **Step 4: Run** → pass (fix any off-by-one the tests reveal; tests are the contract).
- [ ] **Step 5: Commit** `feat(study): pre-registered pockets, trades, stats and bars`.

---

### Task 7: Study runner, report, tables

**Files:** Create `scripts/kalshi_study.py`, append `run_study`/`render_report` to `scripts/kalshi_edges/study.py`; Test append to `scripts/tests/test_kalshi_study.py`

- [ ] **Step 1: Failing tests** (append)

```python
from kalshi_edges.study import evaluate, render_report

def test_evaluate_splits_seasons_and_forward():
    # bid .15 -> NO costs .85 (band .80-.90); note 1 - .10 == .90 would land in .90-.98
    rows = [row(f"d{i}", gd=f"2025-12-{1 + i % 25:02d}", bid=0.15, ask=0.17, result="no") for i in range(400)]
    rows += [row(f"c{i}", gd=f"2026-10-{20 + i % 10:02d}", season="2026-27", bid=0.15, ask=0.17, result="no") for i in range(150)]
    fwd = [{"pocket_id": "no|band:.80-.90", "pnl": 0.08, "price": 0.88, "fee": 0.007, "won": True}]
    pockets = {p["id"]: p for p in evaluate(rows, fwd)}
    p = pockets["no|band:.80-.90"]
    assert p["disc_n"] == 400 and p["conf_n"] == 150 and p["fwd_n"] == 1 and p["status"] == "confirmed"
    assert pockets["yes|band:.10-.20"]["status"] == "rejected"
    assert len(pockets) == 176

def test_render_report_mentions_counts():
    rows = [row("a")]
    md = render_report(evaluate(rows, []), calibration(rows), n_rows=1)
    assert "176 pockets" in md and "0 passed discovery" in md
```

- [ ] **Step 2: Run** → ImportError.
- [ ] **Step 3: Implement** (append to `study.py`):

```python
def _summary(ts):
    return pocket_stats(ts) if ts else {"n": 0, "roi": 0.0, "roi_h1": 0.0, "roi_h2": 0.0, "p": 1.0}


def evaluate(rows, forward_trades):
    """rows: kalshi_settled rows; forward_trades: graded kalshi_pocket_trades (won not null).
    Returns one kalshi_pockets row per pre-registered pocket."""
    trades = build_trades(rows)
    disc = by_pocket([t for t in trades if t.season == "2025-26"])
    conf = by_pocket([t for t in trades if t.season != "2025-26"])
    fwd = defaultdict(list)
    for f in forward_trades:
        if f.get("won") is not None:
            fwd[f["pocket_id"]].append(f)
    out = []
    for pid in POCKET_IDS:
        d, c = _summary(disc.get(pid, [])), _summary(conf.get(pid, []))
        fl = fwd.get(pid, [])
        staked = sum(float(f["price"]) + float(f["fee"]) for f in fl)
        fw = {"n": len(fl), "roi": (sum(float(f["pnl"]) for f in fl) / staked) if staked else 0.0}
        out.append({"id": pid, "side": pid.split("|")[0], "definition": definition(pid),
                    "disc_n": d["n"], "disc_roi": round(d["roi"], 5), "disc_roi_h1": round(d["roi_h1"], 5),
                    "disc_roi_h2": round(d["roi_h2"], 5), "disc_p": d["p"],
                    "conf_n": c["n"], "conf_roi": round(c["roi"], 5),
                    "fwd_n": fw["n"], "fwd_roi": round(fw["roi"], 5),
                    "status": status_of(d, c, fw)})
    return out


def render_report(pockets, cal, n_rows):
    passed = [p for p in pockets if p["status"] != "rejected"]
    lines = [f"# Kalshi calibration study", "",
             f"{n_rows} settled markets; {len(pockets)} pockets tested (pre-registered, K={K}, "
             f"alpha {ALPHA:.2e}); {len(passed)} passed discovery.", "",
             "## Calibration (YES ask band vs realized YES rate)", "",
             "| season | band | n | mean ask | YES rate |", "|---|---|---|---|---|"]
    lines += [f"| {c['season']} | {c['band']} | {c['n']} | {c['mean_ask']:.3f} | {c['yes_rate']:.3f} |" for c in cal]
    lines += ["", "## Pockets that passed discovery", ""]
    if passed:
        lines += ["| pocket | disc n | disc ROI | p | conf n | conf ROI | status |", "|---|---|---|---|---|---|---|"]
        lines += [f"| {p['id']} | {p['disc_n']} | {p['disc_roi']:+.1%} | {p['disc_p']:.1e} | {p['conf_n']} | "
                  f"{p['conf_roi']:+.1%} | {p['status']} |" for p in passed]
    else:
        lines.append("None.")
    best = sorted(pockets, key=lambda p: -p["disc_roi"])[:15]
    lines += ["", "## Top 15 pockets by discovery ROI (for context; bars decide)", "",
              "| pocket | disc n | disc ROI | h1 | h2 | p | status |", "|---|---|---|---|---|---|---|"]
    lines += [f"| {p['id']} | {p['disc_n']} | {p['disc_roi']:+.1%} | {p['disc_roi_h1']:+.1%} | "
              f"{p['disc_roi_h2']:+.1%} | {p['disc_p']:.1e} | {p['status']} |" for p in best]
    return "\n".join(lines) + "\n"
```

Note the test string "0 passed discovery": render uses `{len(passed)} passed discovery`.

`scripts/kalshi_study.py`:
```python
"""Run the pre-registered Kalshi calibration study: update kalshi_pockets / kalshi_calibration.
Usage: python kalshi_study.py [--report]   (--report also writes docs/kalshi-study/<date>-calibration.{md,json})"""
import json, os, sys
from datetime import date
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.study import calibration, evaluate, render_report  # noqa: E402

COLS = "ticker,player,stat,strike,game_date,season,pretip_yes_bid,pretip_yes_ask,pretip_volume,result"
MIN_DISCOVERY_ROWS = 1000

if __name__ == '__main__':
    load_env_local()
    rows = sb.select_all("kalshi_settled", f"select={COLS}&order=ticker")
    n_disc = sum(r["season"] == "2025-26" for r in rows)
    if n_disc < MIN_DISCOVERY_ROWS:
        print(f"kalshi_study: only {n_disc} 2025-26 rows; backfill incomplete, not writing pockets")
        sys.exit(1)
    fwd = sb.select_all("kalshi_pocket_trades", "select=pocket_id,price,fee,pnl,won&won=not.is.null&order=id")
    pockets, cal = evaluate(rows, fwd), calibration(rows)
    sb.upsert("kalshi_pockets", pockets, "id")
    sb.upsert("kalshi_calibration", cal, "season,band")
    print(f"kalshi_study: {len(rows)} rows, {sum(p['status'] != 'rejected' for p in pockets)} pockets passed discovery")
    if '--report' in sys.argv:
        out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'kalshi-study')
        os.makedirs(out, exist_ok=True)
        stem = os.path.join(out, f"{date.today().isoformat()}-calibration")
        with open(stem + '.md', 'w', encoding='utf-8') as f:
            f.write(render_report(pockets, cal, len(rows)))
        with open(stem + '.json', 'w', encoding='utf-8') as f:
            json.dump({"n_rows": len(rows), "pockets": pockets, "calibration": cal}, f, indent=1)
        print(f"report: {stem}.md")
```

- [ ] **Step 4: Run tests** → pass. **Step 5: Commit** `feat(study): study runner, report and tables`.

---

### Task 8: Live pocket scan and grading

**Files:** Create `scripts/kalshi_edges/pockets_live.py`, `scripts/kalshi_pocket_scan.py`, `scripts/kalshi_pocket_grade.py`; Test `scripts/tests/test_kalshi_pockets_live.py`

- [ ] **Step 1: Failing tests**

```python
from datetime import datetime, timedelta, timezone
from kalshi_edges.pockets_live import scan_trades, grade_updates

NOW = datetime(2026, 11, 8, 0, 0, tzinfo=timezone.utc)

def mk(t, teams="BOSCHA", ask=0.17, bid=0.15, vol=5, strike=20):   # NO costs .85
    return {"ticker": f"KXNBAPTS-26NOV07{teams}-{t}-{strike}", "player": "A B", "stat": "points", "strike": strike,
            "game_date": "2026-11-07", "yes_bid": bid, "yes_ask": ask, "volume": vol}

def test_scan_only_games_tipping_within_45_minutes():
    tips = {"BOSCHA": NOW + timedelta(minutes=30), "MINNOP": NOW + timedelta(minutes=90)}
    rows = [mk("x"), mk("y", teams="MINNOP")]
    out = scan_trades(rows, tips, NOW, active={"no|band:.80-.90", "yes|band:.10-.20"})
    assert {(o["ticker"].split("-")[2], o["pocket_id"], o["side"]) for o in out} == {
        ("x", "no|band:.80-.90", "no"), ("x", "yes|band:.10-.20", "yes")}   # YES at .17
    o = next(o for o in out if o["side"] == "no")
    assert abs(o["price"] - 0.85) < 1e-9 and o["game_date"] == "2026-11-07"

def test_scan_skips_tipped_games():
    out = scan_trades([mk("x")], {"BOSCHA": NOW - timedelta(minutes=1)}, NOW, active={"no|band:.80-.90"})
    assert out == []

def test_grade_updates():
    trades = [{"id": 1, "ticker": "a", "side": "yes", "price": 0.4, "fee": 0.0168},
              {"id": 2, "ticker": "b", "side": "no", "price": 0.6, "fee": 0.0168},
              {"id": 3, "ticker": "c", "side": "yes", "price": 0.4, "fee": 0.0168},
              {"id": 4, "ticker": "d", "side": "yes", "price": 0.4, "fee": 0.0168}]
    results = {"a": "yes", "b": "yes", "c": "void"}
    ups = {u["id"]: u for u in grade_updates(trades, results)}
    assert ups[1]["won"] is True and abs(ups[1]["pnl"] - (1 - 0.4 - 0.0168)) < 1e-9
    assert ups[2]["won"] is False and abs(ups[2]["pnl"] - -(0.6 + 0.0168)) < 1e-9
    assert ups[3] == {"id": 3, "result": "void", "won": None, "pnl": 0.0}
    assert 4 not in ups
```

- [ ] **Step 2: Run** → ImportError.
- [ ] **Step 3: Implement** `scripts/kalshi_edges/pockets_live.py`:

```python
"""Forward paper trading of confirmed/live pockets (spec 2026-11-07)."""
from datetime import timedelta

from kalshi_edges.study import build_trades, classify
from kalshi_edges.teams import ticker_teams

WINDOW = timedelta(minutes=45)
ACTIVE_STATUSES = ("confirmed", "live")


def scan_trades(market_rows, tips, now, active):
    """market_rows: today's kalshi_markets rows; tips: {ticker team string: tip dt};
    active: pocket ids to trade. Returns kalshi_pocket_trades rows (unsettled)."""
    soon = [r for r in market_rows
            if (tip := tips.get(ticker_teams(r["ticker"]))) is not None and now < tip <= now + WINDOW]
    mapped = [{"ticker": r["ticker"], "player": r["player"], "stat": r["stat"], "strike": r["strike"],
               "game_date": r["game_date"], "pretip_yes_bid": r.get("yes_bid"),
               "pretip_yes_ask": r.get("yes_ask"), "pretip_volume": r.get("volume"), "result": None}
              for r in soon]
    out = []
    for t in build_trades(mapped, require_result=False):
        for pid in classify(t):
            if pid in active:
                out.append({"pocket_id": pid, "ticker": t.ticker, "side": t.side, "price": round(t.price, 4),
                            "fee": round(t.fee, 6), "game_date": t.game_date})
    return out


def grade_updates(open_trades, results):
    """results: {ticker: 'yes'|'no'|'void'} from kalshi_markets. Ungraded tickers are skipped."""
    out = []
    for t in open_trades:
        res = results.get(t["ticker"])
        if res == "void":
            out.append({"id": t["id"], "result": "void", "won": None, "pnl": 0.0})
        elif res in ("yes", "no"):
            won = res == t["side"]
            price, fee = float(t["price"]), float(t["fee"])
            out.append({"id": t["id"], "result": res, "won": won, "pnl": (1 - price - fee) if won else -(price + fee)})
    return out
```

Note: in `scan_trades`, ladder position is computed over the rows of games tipping soon only (same game → same ladder), matching the study's per-game ladders.

`scripts/kalshi_pocket_scan.py`:
```python
"""Pipeline step (pretip): log paper trades for confirmed/live pockets on games tipping within 45 min."""
import os, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.espn import fetch_tip_index  # noqa: E402
from kalshi_edges.pockets_live import ACTIVE_STATUSES, scan_trades  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    active = {p["id"] for p in sb.select_all(
        "kalshi_pockets", f"select=id&status=in.({','.join(ACTIVE_STATUSES)})&order=id")}
    if not active:
        print("kalshi_pocket_scan: no confirmed pockets"); sys.exit(0)
    today = datetime.now(ZoneInfo('America/New_York')).date()
    rows = sb.select_all("kalshi_markets", f"select=ticker,player,stat,strike,game_date,yes_bid,yes_ask,volume"
                                           f"&game_date=eq.{today.isoformat()}&order=ticker")
    trades = scan_trades(rows, fetch_tip_index(today), datetime.now(timezone.utc), active)
    n = sb.insert_ignore("kalshi_pocket_trades", trades, "pocket_id,ticker,side")
    print(f"kalshi_pocket_scan: {len(trades)} candidates, {n} new paper trades")
```

`scripts/kalshi_pocket_grade.py`:
```python
"""Pipeline step (overnight, after kalshi_settle): grade open paper trades from kalshi_markets results."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.pockets_live import grade_updates  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    open_trades = sb.select_all("kalshi_pocket_trades", "select=id,ticker,side,price,fee&result=is.null&order=id")
    tickers = sorted({t["ticker"] for t in open_trades})
    results = {}
    for i in range(0, len(tickers), 100):
        ids = ",".join(f'"{t}"' for t in tickers[i:i + 100])
        for r in sb.select_all("kalshi_markets", f"select=ticker,result&ticker=in.({ids})&result=not.is.null&order=ticker"):
            results[r["ticker"]] = r["result"]
    ups = grade_updates(open_trades, results)
    for u in ups:
        sb.patch("kalshi_pocket_trades", f"id=eq.{u['id']}", {k: v for k, v in u.items() if k != "id"})
    print(f"kalshi_pocket_grade: {len(open_trades)} open, {len(ups)} graded")
```

- [ ] **Step 4: Run** → pass. **Step 5: Commit** `feat(study): forward pocket scan and grading`.

---

### Task 9: Settle writes kalshi_settled; pipeline steps

**Files:** Modify `scripts/kalshi_settle.py`, `scripts/pipeline/phases.py`, `scripts/tests/test_pipeline_phases.py`; append to `scripts/kalshi_edges/history.py`

- [ ] **Step 1: Update phase tests** in `scripts/tests/test_pipeline_phases.py`:

- In `test_overnight_order`, the expected list becomes `[..., 'parlay', 'kalshi_settle', 'kalshi_pocket_grade', 'defense_fresh']`.
- In `test_other_phases`: pretip `['lineups', 'props', 'enrich', 'snapshot', 'kalshi_ingest', 'kalshi_pocket_scan']`, weekly `['player_bias', 'opponent_leaks', 'kalshi_study']`, midday unchanged.
- In `test_kalshi_steps_own_chain_not_critical`: `assert len(ks) == 6`.

- [ ] **Step 2: Run** → 3 failures.
- [ ] **Step 3: phases.py**: insert after the overnight `kalshi_settle` step `Step('kalshi_pocket_grade', 'kalshi', 'python', 'kalshi_pocket_grade.py', -1),`; append to pretip `Step('kalshi_pocket_scan', 'kalshi', 'python', 'kalshi_pocket_scan.py', 0),`; append to weekly `Step('kalshi_study', 'kalshi', 'python', 'kalshi_study.py', 0),`.

- [ ] **Step 4: history.py** — append:

```python
def settle_history(game_dates, session=None):
    """Add kalshi_settled rows for markets of these game dates (live endpoint). Returns BackfillStats."""
    from kalshi_edges.ingest import fetch_settled
    sess = session or requests.Session()
    wanted = set(game_dates)
    raws = [r for r in fetch_settled(game_dates, session=sess) if _game_of(r.get("ticker"))[0] in wanted]
    stats = BackfillStats()
    rows = process_markets(raws, tips_cache(sess), candles_fetcher(sess, historical=False), existing_tickers(), stats)
    if rows:
        sb.upsert("kalshi_settled", rows, "ticker")
    return stats
```

Check `ingest.fetch_settled`'s actual signature first (`grep -n "def fetch_settled" scripts/kalshi_edges/ingest.py`) and adapt the call (it may take `session=` or a positional session).

- [ ] **Step 5: kalshi_settle.py** — after the existing per-date settle loop, add:

```python
    from kalshi_edges.history import settle_history
    st = settle_history(dates)
    print(f'kalshi_settled rows: {st}')
```

using the same `dates` list the script already computes (read the file; it has a `target_dates` helper).

- [ ] **Step 6: Run full suite** → pass. **Step 7: Commit** `feat(study): pipeline steps + nightly kalshi_settled rows`.

---

### Task 10: Edge tab

**Files:** Create `lib/kalshi/edge.ts`, `lib/__tests__/kalshi-edge.test.ts`, `components/CalibrationChart.tsx`; Replace `app/markets/edge/page.tsx`

- [ ] **Step 1: Failing tests** `lib/__tests__/kalshi-edge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pocketLabel, chartPoints, STATUS_LABEL } from '@/lib/kalshi/edge'

describe('pocketLabel', () => {
  it('formats ids readably', () => {
    expect(pocketLabel('no|band:.05-.10')).toBe('NO · 5–10¢')
    expect(pocketLabel('yes|band:.10-.20|stat:pra')).toBe('YES · 10–20¢ · Pts+Reb+Ast')
    expect(pocketLabel('yes|pos:top')).toBe('YES · top rung')
    expect(pocketLabel('no|spread:>10')).toBe('NO · spread >10¢')
    expect(pocketLabel('yes|vol:100+')).toBe('YES · volume 100+')
  })
  it('has a label for every status', () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(
      ['confirmed', 'discovery_pass', 'failed_confirmation', 'failed_forward', 'live', 'rejected'])
  })
})

describe('chartPoints', () => {
  it('maps probability 0..1 to the plot box (y inverted)', () => {
    const [p] = chartPoints([{ season: '2025-26', band: '.10-.20', n: 10, mean_ask: 0.1, yes_rate: 0.2 }], 200, 100, 10)
    expect(p.x).toBeCloseTo(10 + 0.1 * 180)
    expect(p.y).toBeCloseTo(10 + (1 - 0.2) * 80)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run lib/__tests__/kalshi-edge.test.ts` → fails to resolve.
- [ ] **Step 3: Implement** `lib/kalshi/edge.ts`:

```ts
import { STAT_LABEL, type MarketStat } from '@/lib/kalshi/ladder'

export interface CalibrationRow { season: string; band: string; n: number; mean_ask: number; yes_rate: number }
export interface PocketRow {
  id: string; status: string
  disc_n: number; disc_roi: number; disc_p: number
  conf_n: number; conf_roi: number; fwd_n: number; fwd_roi: number
}

export const STATUS_LABEL: Record<string, string> = {
  rejected: 'Rejected', discovery_pass: 'Waiting on 2026-27 sample', failed_confirmation: 'Failed 2026-27',
  confirmed: 'Paper trading', failed_forward: 'Failed forward test', live: 'Passed forward test',
}

const cents = (s: string) => `${Math.round(parseFloat(s) * 100)}`

export function pocketLabel(id: string): string {
  const [side, ...parts] = id.split('|')
  const out = [side.toUpperCase()]
  for (const p of parts) {
    const [k, v] = p.split(':')
    if (k === 'band') { const [lo, hi] = v.split('-'); out.push(`${cents(lo)}–${cents(hi)}¢`) }
    else if (k === 'stat') out.push(STAT_LABEL[v as MarketStat] ?? v)
    else if (k === 'pos') out.push(`${v} rung`)
    else if (k === 'spread') out.push(`spread ${v}¢`)
    else if (k === 'vol') out.push(`volume ${v}`)
  }
  return out.join(' · ')
}

/** Plot coordinates in a w x h box with `pad` margin; x = mean ask, y = realized YES rate. */
export function chartPoints(rows: CalibrationRow[], w: number, h: number, pad: number) {
  return rows.map((r) => ({
    ...r,
    x: pad + Number(r.mean_ask) * (w - 2 * pad),
    y: pad + (1 - Number(r.yes_rate)) * (h - 2 * pad),
  }))
}
```

`components/CalibrationChart.tsx` (server component):

```tsx
import { chartPoints, type CalibrationRow } from '@/lib/kalshi/edge'

const W = 520, H = 320, PAD = 36
const COLORS: Record<string, string> = { '2025-26': '#8b5cf6', '2026-27': '#22c55e' }

export function CalibrationChart({ rows }: { rows: CalibrationRow[] }) {
  const pts = chartPoints(rows, W, H, PAD)
  const seasons = [...new Set(rows.map((r) => r.season))].sort()
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const sx = (v: number) => PAD + v * (W - 2 * PAD)
  const sy = (v: number) => PAD + (1 - v) * (H - 2 * PAD)
  return (
    <figure className="w-full max-w-[560px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label="Kalshi pre-tip YES price vs how often YES actually hit">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(0)} x2={sx(1)} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={0.08} />
            <text x={PAD - 6} y={sy(t) + 4} fontSize={10} textAnchor="end" fill="currentColor" opacity={0.5}>{Math.round(t * 100)}%</text>
            <text x={sx(t)} y={H - PAD + 16} fontSize={10} textAnchor="middle" fill="currentColor" opacity={0.5}>{Math.round(t * 100)}¢</text>
          </g>
        ))}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        {seasons.map((s) => {
          const line = pts.filter((p) => p.season === s).sort((a, b) => a.x - b.x)
          return (
            <g key={s}>
              <polyline points={line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={COLORS[s] ?? '#999'} strokeWidth={2} />
              {line.map((p) => (
                <circle key={p.band} cx={p.x} cy={p.y} r={3.5} fill={COLORS[s] ?? '#999'}>
                  <title>{`${s} ${p.band}: price ${Math.round(Number(p.mean_ask) * 100)}¢, hit ${Math.round(Number(p.yes_rate) * 100)}% (n=${p.n})`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-2 flex gap-4 text-xs text-[var(--text-tertiary)]">
        {seasons.map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS[s] ?? '#999' }} />{s}
          </span>
        ))}
        <span>Dashed line = priced exactly right</span>
      </figcaption>
    </figure>
  )
}
```

`app/markets/edge/page.tsx`:

```tsx
import { supabase } from '@/lib/supabase'
import { CalibrationChart } from '@/components/CalibrationChart'
import { pocketLabel, STATUS_LABEL, type CalibrationRow, type PocketRow } from '@/lib/kalshi/edge'

export const revalidate = 300

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}%`

export default async function MarketsEdge() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [{ data: cal }, { data: pockets }, { data: paper }] = await Promise.all([
    supabase.from('kalshi_calibration').select('season, band, n, mean_ask, yes_rate'),
    supabase.from('kalshi_pockets').select('id, status, disc_n, disc_roi, disc_p, conf_n, conf_roi, fwd_n, fwd_roi'),
    supabase.from('kalshi_pocket_trades').select('pocket_id, ticker, side, price').eq('game_date', today).order('ticker'),
  ])
  const all = (pockets ?? []) as PocketRow[]
  const shown = all.filter((p) => p.status !== 'rejected').sort((a, b) => Number(b.disc_roi) - Number(a.disc_roi))
  const rejected = all.length - shown.length

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-10">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
        <h1 className="mt-1 text-2xl font-bold text-[var(--text-primary)]">Edge</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Is Kalshi priced right? Every settled player prop since Nov 2025, priced just before tip. Pockets must pass
          a pre-registered test on last season, hold up this season, then win in forward paper trading.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Calibration</h2>
        {cal?.length ? <CalibrationChart rows={cal as CalibrationRow[]} /> :
          <p className="text-sm text-[var(--text-secondary)]">The study has not run yet.</p>}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Pockets</h2>
        {all.length > 0 && <p className="mb-3 text-xs text-[var(--text-tertiary)]">{rejected} of {all.length} tested pockets rejected.</p>}
        {shown.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">No pocket passed the pre-registered test.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs tabular-nums">
              <thead className="text-left text-[var(--text-tertiary)]">
                <tr><th className="py-1 pr-3">Pocket</th><th className="pr-3">2025-26</th><th className="pr-3">2026-27</th><th className="pr-3">Forward</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 font-semibold text-[var(--text-primary)]">{pocketLabel(p.id)}</td>
                    <td className="pr-3">{pct(p.disc_roi)} <span className="text-[var(--text-tertiary)]">n={p.disc_n}</span></td>
                    <td className="pr-3">{pct(p.conf_roi)} <span className="text-[var(--text-tertiary)]">n={p.conf_n}</span></td>
                    <td className="pr-3">{p.fwd_n ? <>{pct(p.fwd_roi)} <span className="text-[var(--text-tertiary)]">n={p.fwd_n}</span></> : '—'}</td>
                    <td>{STATUS_LABEL[p.status] ?? p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Today&apos;s paper rungs</h2>
        {paper?.length ? (
          <ul className="space-y-1 text-xs">
            {paper.map((t) => (
              <li key={`${t.pocket_id}|${t.ticker}|${t.side}`} className="flex flex-wrap gap-x-3">
                <span className="rounded bg-white/10 px-1.5 text-[10px] font-semibold uppercase">paper</span>
                <span className="font-semibold text-[var(--text-primary)]">{t.ticker}</span>
                <span>{String(t.side).toUpperCase()} at {Math.round(Number(t.price) * 100)}¢</span>
                <span className="text-[var(--text-tertiary)]">{pocketLabel(t.pocket_id)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            {shown.some((p) => p.status === 'confirmed' || p.status === 'live')
              ? 'Paper rungs are logged in the 45 minutes before each tip.'
              : 'No pocket has confirmed yet, so nothing is being paper traded.'}
          </p>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Run** `npx tsc --noEmit && npx eslint app/markets components/CalibrationChart.tsx lib/kalshi && npx vitest run` → clean.
- [ ] **Step 5: Commit** `feat(study): Edge tab with calibration chart, pockets and paper rungs`.

---

### Task 11: Run it (controller)

- [ ] **Step 1:** Full backfill in the background on the PC: `cd scripts && python3 kalshi_backfill.py > ../.logs/kalshi-backfill.log 2>&1` (hours; resumable). Watch the log's `no_tip` counts in the first minutes; if the guard trips, fix team codes in `teams.py` and rerun.
- [ ] **Step 2:** Check coverage via Supabase MCP: `select season, stat, count(*), count(pretip_yes_ask) asks from kalshi_settled group by 1,2 order by 1,2;`.
- [ ] **Step 3:** `python3 kalshi_study.py --report`; commit `docs/kalshi-study/<date>-calibration.{md,json}` with message `docs: Kalshi calibration study results`.
- [ ] **Step 4:** Preview `/markets/edge` (chart, pocket table or "no pocket passed", paper section empty state), no console errors, mobile width OK.
- [ ] **Step 5:** Report results to the user plainly (including "nothing passed" if so). Merge `feat/kalshi-study` to master and push only with the user's go-ahead.
