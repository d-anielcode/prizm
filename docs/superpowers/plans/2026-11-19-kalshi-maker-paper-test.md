# Kalshi Maker Paper Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log simulated one-contract resting bids on Kalshi NBA props and game totals in the last 3 h before tip, score them after the game against Kalshi's trade history with a queue-aware fill rule, and judge them against a pre-registered bar. **No real or demo orders, ever.**

**Architecture:**
- Pure logic lives in `scripts/kalshi_edges/maker_quotes.py`, with thin Kalshi and Supabase I/O at its bottom:
  - which sides are eligible
  - queue depth
  - the fill rule
  - scoring
  - bar math
- `scripts/kalshi_maker_post.py` runs in the `kalshi_live` phase every ~15 min and writes orders into the new `kalshi_maker_quotes` table.
- `scripts/kalshi_maker_settle.py` runs in `overnight`. It pulls each ticker's trades and result and fills in the outcome columns.
- `scripts/kalshi_maker_report.py` prints progress. It shows ROI only at the pre-registered end point.

**Tech Stack:** Python 3 with `requests`, `scipy` (already installed in CI and the pipeline workflows) and pytest. Supabase PostgREST via `kalshi_edges.sb`. Kalshi public REST: `/markets`, `/markets/{t}`, `/markets/{t}/orderbook`, `/markets/trades`, `/historical/trades`.

**Spec:** `docs/superpowers/specs/2026-11-19-kalshi-maker-paper-test-design.md`

**Conventions:**
- Run every Python command from `C:\Users\dcho0\nbaiqproject\scripts` with `python` (Python 3.14).
- Work on branch `kalshi-maker-paper`, never on `master`; pushing `master` deploys production.
- Do not push. The user decides on merging and pushing.

**Live API facts (verified 2026-11-19):**
- The orderbook response is shaped like this; levels are sorted by ascending price and contain bids only:
  ```
  {"orderbook_fp": {"yes_dollars": [["0.6100","1304.00"], ...], "no_dollars": [...]}}
  ```
- A trade looks like this:
  ```
  {"created_time": "2026-11-19T18:39:33.82832Z", "yes_price_dollars": "0.0700", "count_fp": "205.60", "taker_side": "yes", "is_block_trade": false, "ticker": "KXNBATOTAL-26NOV19GSWMEM-254"}
  ```
- Totals tickers follow the props format, `SERIES-YYMONDDAWAYHOME-N`, so `market_data._game_of` parses both.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261119120000_kalshi_maker_quotes.sql` (create) | table, grants, RLS |
| `scripts/kalshi_edges/maker_quotes.py` (create) | pure logic plus Kalshi I/O helpers |
| `scripts/tests/test_kalshi_maker_quotes.py` (create) | unit tests for all pure functions |
| `scripts/kalshi_maker_post.py` (create) | pipeline step: post paper orders |
| `scripts/kalshi_maker_settle.py` (create) | pipeline step: score paper orders |
| `scripts/kalshi_maker_report.py` (create) | progress / final report CLI |
| `scripts/pipeline/phases.py` (modify) | add the two steps |
| `scripts/tests/test_pipeline_phases.py` (modify) | expected step lists |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
cd /c/Users/dcho0/nbaiqproject && git checkout -b kalshi-maker-paper
git add docs/superpowers/specs/2026-11-19-kalshi-maker-paper-test-design.md docs/superpowers/plans/2026-11-19-kalshi-maker-paper-test.md
git commit -m "docs: spec + plan for Kalshi maker paper test"
```

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/20261119120000_kalshi_maker_quotes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Kalshi maker (limit-order) forward paper test (spec 2026-11-19).
-- One row per simulated resting bid: (ticker, side) is unique, posted once, held to tip.
-- Posted by scripts/kalshi_maker_post.py (kalshi_live); scored by scripts/kalshi_maker_settle.py (overnight).
-- New tables on this project get no API grants by default, so grants are explicit.
CREATE TABLE IF NOT EXISTS kalshi_maker_quotes (
  id           bigserial PRIMARY KEY,
  ticker       text NOT NULL,
  market       text NOT NULL CHECK (market IN ('props', 'totals')),
  side         text NOT NULL CHECK (side IN ('yes', 'no')),
  price        numeric NOT NULL,        -- our bid on that side, dollars
  queue_ahead  numeric NOT NULL,        -- contracts resting at our price when posted
  posted_at    timestamptz NOT NULL,
  tip_time     timestamptz NOT NULL,
  game_date    date NOT NULL,           -- ET game date from the ticker
  filled       boolean,                 -- null until scored
  fill_ts      timestamptz,
  result       text,                    -- yes / no / void
  fee          numeric,                 -- maker fee per contract, filled orders only
  pnl          numeric,                 -- per contract, filled orders only
  scored_at    timestamptz,
  UNIQUE (ticker, side)
);
CREATE INDEX IF NOT EXISTS kalshi_maker_quotes_unscored_idx ON kalshi_maker_quotes (tip_time) WHERE scored_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON kalshi_maker_quotes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE kalshi_maker_quotes_id_seq TO service_role;
GRANT SELECT ON kalshi_maker_quotes TO anon, authenticated;
ALTER TABLE kalshi_maker_quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read" ON kalshi_maker_quotes;
CREATE POLICY "anon_read" ON kalshi_maker_quotes FOR SELECT TO anon, authenticated USING (true);
```

- [ ] **Step 2: Apply it.** This is a production database change, so ask the user first.

Apply it with the Supabase MCP tool `apply_migration`:
- project `shvoyqofsbtnzwokuutt`
- name `kalshi_maker_quotes`
- the SQL above

Then verify with `execute_sql`:

```sql
select count(*) from kalshi_maker_quotes;
```

Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261119120000_kalshi_maker_quotes.sql
git commit -m "feat(kalshi): kalshi_maker_quotes table for maker paper test"
```

---

### Task 2: Which sides are eligible, queue depth, tip lookup

**Files:**
- Create: `scripts/kalshi_edges/maker_quotes.py`
- Create: `scripts/tests/test_kalshi_maker_quotes.py`

- [ ] **Step 1: Write the failing tests**

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from datetime import date, datetime, timedelta, timezone
from kalshi_edges.maker_quotes import eligible_sides, best_bid, make_quote, tip_for

TIP = datetime(2026, 11, 20, 0, 30, tzinfo=timezone.utc)


def test_eligible_both_sides_in_band():
    now = TIP - timedelta(hours=1)
    # yes bid 0.70 in band; no bid = 1 - 0.25 = 0.75 in band
    assert eligible_sides(0.70, 0.25, now, TIP) == [("yes", 0.70), ("no", 0.75)]


def test_eligible_band_edges():
    now = TIP - timedelta(hours=1)
    assert eligible_sides(0.60, 0.95, now, TIP) == [("yes", 0.60)]   # 0.60 in; no side 0.05 out
    assert eligible_sides(0.90, 0.95, now, TIP) == []                # 0.90 out (half-open)
    assert eligible_sides(0.05, 0.10, now, TIP) == []                # no side = 0.90, out (half-open)


def test_eligible_window_edges():
    assert eligible_sides(0.70, 0.75, TIP - timedelta(hours=3), TIP) == [("yes", 0.70)]
    assert eligible_sides(0.70, 0.75, TIP - timedelta(hours=3, seconds=1), TIP) == []
    assert eligible_sides(0.70, 0.75, TIP, TIP) == []
    assert eligible_sides(0.70, 0.75, TIP + timedelta(minutes=5), TIP) == []
    assert eligible_sides(0.70, 0.75, TIP - timedelta(hours=1), None) == []


def test_eligible_missing_prices():
    now = TIP - timedelta(hours=1)
    assert eligible_sides(None, None, now, TIP) == []
    assert eligible_sides(0.0, 1.0, now, TIP) == []


BOOK = {"orderbook_fp": {"yes_dollars": [["0.6000", "10.00"], ["0.6800", "250.00"], ["0.7000", "0.00"]],
                         "no_dollars": [["0.2500", "40.00"], ["0.3000", "12.50"]]}}


def test_best_bid_skips_empty_levels():
    assert best_bid(BOOK, "yes") == (0.68, 250.0)
    assert best_bid(BOOK, "no") == (0.30, 12.5)
    assert best_bid({"orderbook_fp": {"yes_dollars": None}}, "yes") is None
    assert best_bid({}, "no") is None


def test_make_quote_uses_book_price_and_depth():
    now = TIP - timedelta(hours=2)
    q = make_quote("KXNBATOTAL-26NOV19GSWMEM-230", "totals", "yes", BOOK, now, TIP, "2026-11-19")
    assert q == {"ticker": "KXNBATOTAL-26NOV19GSWMEM-230", "market": "totals", "side": "yes",
                 "price": 0.68, "queue_ahead": 250.0, "posted_at": now.isoformat(),
                 "tip_time": TIP.isoformat(), "game_date": "2026-11-19"}


def test_make_quote_none_when_book_out_of_band():
    now = TIP - timedelta(hours=2)
    assert make_quote("T", "totals", "no", BOOK, now, TIP, "2026-11-19") is None   # 0.30 out of band


def test_tip_for_tries_spellings():
    tips = {"GSWMEM": TIP}
    assert tip_for(tips, "GSW", "MEM") == TIP
    assert tip_for(tips, "GS", "MEM") == TIP      # alias spelling resolves via teams.spellings
    assert tip_for(tips, "LAL", "BOS") is None
    assert tip_for(tips, None, "MEM") is None
```

(Verified 2026-11-19: `teams.spellings("GS") == {"GS", "GSW"}`.)

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `python -m pytest tests/test_kalshi_maker_quotes.py -q`

Expected: an error collecting the file, `ModuleNotFoundError: No module named 'kalshi_edges.maker_quotes'`.

- [ ] **Step 3: Implement**

`scripts/kalshi_edges/maker_quotes.py`:

```python
"""Kalshi maker (limit-order) forward paper test — spec 2026-11-19-kalshi-maker-paper-test-design.md.

Pure functions first (eligibility, queue, fill rule, scoring, bar); thin Kalshi I/O at
the bottom. PAPER ONLY: nothing here, or in the scripts that use it, places an order.
"""
from datetime import date, datetime, timedelta

from kalshi_edges.teams import spellings

LO, HI = 0.60, 0.90                 # side price band, half-open [LO, HI)
WINDOW = timedelta(hours=3)         # post only within 3 h before tip


def _r(x):
    return round(float(x), 4)


def in_band(p):
    return p is not None and LO <= p < HI


def eligible_sides(yes_bid, yes_ask, now, tip):
    """[(side, price)] a new resting bid could join right now; [] outside the 3 h window.
    YES side's best bid = yes_bid; NO side's best bid = 1 - yes_ask."""
    if tip is None or not (timedelta(0) < tip - now <= WINDOW):
        return []
    out = []
    if yes_bid is not None and in_band(_r(yes_bid)):
        out.append(("yes", _r(yes_bid)))
    if yes_ask is not None and 0 < yes_ask < 1 and in_band(_r(1 - yes_ask)):
        out.append(("no", _r(1 - yes_ask)))
    return out


def best_bid(orderbook, side):
    """(price, contracts) at the best non-empty bid on `side` of a GET /markets/{t}/orderbook
    response, or None."""
    levels = ((orderbook or {}).get("orderbook_fp") or {}).get(f"{side}_dollars") or []
    best = None
    for p, q in levels:
        p, q = _r(p), float(q)
        if q > 0 and (best is None or p > best[0]):
            best = (p, q)
    return best


def make_quote(ticker, market, side, orderbook, now, tip, game_date):
    """Paper order joining the back of the queue at the book's best bid, or None when that
    bid is outside the band. queue_ahead = everything already resting at that price."""
    b = best_bid(orderbook, side)
    if b is None or not in_band(b[0]):
        return None
    return {"ticker": ticker, "market": market, "side": side, "price": b[0], "queue_ahead": b[1],
            "posted_at": now.isoformat(), "tip_time": tip.isoformat(), "game_date": game_date}


def tip_for(tips, away, home):
    """Tip datetime from an espn.tip_index dict for the ticker's team codes, or None."""
    if not away or not home:
        return None
    for a in spellings(away):
        for h in spellings(home):
            if a + h in tips:
                return tips[a + h]
    return None
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `python -m pytest tests/test_kalshi_maker_quotes.py -q`

Expected: `8 passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/maker_quotes.py scripts/tests/test_kalshi_maker_quotes.py
git commit -m "feat(kalshi): maker paper test - eligibility, queue depth, tip lookup"
```

---

### Task 3: Queue-aware fill rule

**Files:**
- Modify: `scripts/kalshi_edges/maker_quotes.py` (append)
- Modify: `scripts/tests/test_kalshi_maker_quotes.py` (append)

- [ ] **Step 1: Write the failing tests** (append)

```python
from kalshi_edges.maker_quotes import fill_time

POSTED = TIP - timedelta(hours=2)


def quote(side="yes", price=0.70, queue=100.0):
    return {"side": side, "price": price, "queue_ahead": queue,
            "posted_at": POSTED.isoformat(), "tip_time": TIP.isoformat()}


def tr(minutes_after_post, yes_price, count, taker_side, block=False):
    t = POSTED + timedelta(minutes=minutes_after_post)
    return {"created_time": t.isoformat().replace("+00:00", "Z"), "yes_price_dollars": f"{yes_price:.4f}",
            "count_fp": f"{count:.2f}", "taker_side": taker_side, "is_block_trade": block}


def test_through_price_fills_immediately():
    # YES bid at 0.70; a taker sells YES at 0.65 (taker_side 'no') -> went through our level
    trades = [tr(10, 0.65, 1, "no")]
    assert fill_time(quote(), trades) == trades[0]["created_time"]


def test_queue_consumed_then_next_hit_fills():
    trades = [tr(5, 0.70, 60, "no"), tr(6, 0.70, 40, "no"), tr(7, 0.70, 1, "no")]
    # 60 + 40 = 100 exactly consumes the queue; we fill on the third trade
    assert fill_time(quote(queue=100), trades) == trades[2]["created_time"]


def test_queue_overrun_in_one_trade_fills_on_that_trade():
    trades = [tr(5, 0.70, 150, "no")]
    assert fill_time(quote(queue=100), trades) == trades[0]["created_time"]


def test_queue_never_consumed_no_fill():
    assert fill_time(quote(queue=100), [tr(5, 0.70, 99, "no")]) is None


def test_wrong_side_and_better_priced_trades_ignored():
    trades = [tr(5, 0.70, 500, "yes"),   # taker bought YES: hits YES asks, not our bid
              tr(6, 0.72, 500, "no")]    # sold into a better (higher) YES bid ahead of ours
    assert fill_time(quote(queue=0), trades) is None


def test_trades_outside_window_and_blocks_ignored():
    before = tr(-1, 0.60, 10, "no")
    after_tip = tr(121, 0.60, 10, "no")
    block = tr(30, 0.60, 10, "no", block=True)
    assert fill_time(quote(), [before, after_tip, block]) is None


def test_no_side_mirrors_prices():
    # NO bid at 0.75 <=> YES price 0.25. Taker buys YES (taker_side 'yes') at 0.24 -> NO price 0.76 > 0.75: ignored.
    # Taker buys YES at 0.26 -> NO price 0.74 < 0.75: through our level -> fill.
    q = quote(side="no", price=0.75, queue=10)
    trades = [tr(5, 0.24, 50, "yes"), tr(6, 0.26, 1, "yes")]
    assert fill_time(q, trades) == trades[1]["created_time"]


def test_unsorted_trades_processed_in_time_order():
    trades = [tr(9, 0.70, 1, "no"), tr(5, 0.70, 100, "no")]
    assert fill_time(quote(queue=100), trades) == trades[0]["created_time"]
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `python -m pytest tests/test_kalshi_maker_quotes.py -q`

Expected: an ImportError on `fill_time`.

- [ ] **Step 3: Implement** (append to `maker_quotes.py`)

```python
def _ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _hit_price(side, trade):
    """Our-side price of a trade where the taker sold into `side`'s bids, else None.
    YES bid is hit when the taker buys NO (taker_side 'no'); NO bid when the taker buys YES."""
    y = float(trade["yes_price_dollars"])
    if side == "yes" and trade.get("taker_side") == "no":
        return _r(y)
    if side == "no" and trade.get("taker_side") == "yes":
        return _r(1 - y)
    return None


def fill_time(quote, trades):
    """Queue-aware fill (spec section 3). Walk non-block trades in (posted_at, tip_time] oldest first:
    a hit below our price fills us; a hit at our price first uses up queue_ahead (we fill once
    it goes negative); hits above our price and other-side trades are ignored. Unseen
    cancellations ahead of us are assumed not to happen (undercounts fills). Returns the
    filling trade's created_time, or None."""
    side, price = quote["side"], _r(quote["price"])
    start, end = _ts(quote["posted_at"]), _ts(quote["tip_time"])
    remaining = float(quote["queue_ahead"])
    for t in sorted(trades, key=lambda t: _ts(t["created_time"])):
        if t.get("is_block_trade") or not (start < _ts(t["created_time"]) <= end):
            continue
        px = _hit_price(side, t)
        if px is None or px > price:
            continue
        if px < price:
            return t["created_time"]
        remaining -= float(t.get("count_fp") or 0)
        if remaining < 0:
            return t["created_time"]
    return None
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `python -m pytest tests/test_kalshi_maker_quotes.py -q`

Expected: `16 passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/maker_quotes.py scripts/tests/test_kalshi_maker_quotes.py
git commit -m "feat(kalshi): queue-aware maker fill rule"
```

---

### Task 4: Settlement result, scoring, pre-registered bar

**Files:**
- Modify: `scripts/kalshi_edges/maker_quotes.py` (append)
- Modify: `scripts/tests/test_kalshi_maker_quotes.py` (append)

Pre-registered constants (spec section 5). Do not change them after the test starts:
- `MAKER_K = 0.0175`
- `MAKER_BAR = {"min_n": 300, "min_roi": 0.02, "alpha": 0.025}`
- `END_DATE = date(2027, 4, 11)`, the last day of the 2026-27 regular season.

**Stop rule:**
- If a market reaches 300 filled-and-settled orders before `END_DATE`, its sample is every filled order on game dates up to and including the date of the 300th, sorted by tip time.
- Otherwise its sample is every filled order with `game_date <= END_DATE`.

- [ ] **Step 1: Write the failing tests** (append)

```python
from kalshi_edges.maker_quotes import (settled_result, score, maker_fee, stop_sample, bar_check,
                                       final_ready, progress, MAKER_BAR, END_DATE)


def test_settled_result():
    assert settled_result({"status": "finalized", "result": "yes"}) == "yes"
    assert settled_result({"status": "settled", "result": "no"}) == "no"
    assert settled_result({"status": "finalized", "result": "scalar"}) == "void"
    assert settled_result({"status": "closed", "result": ""}) is None
    assert settled_result({"status": "finalized", "result": "weird"}) is None


def test_score_filled_win_and_loss():
    q = {"side": "no", "price": 0.75}
    fee = maker_fee(0.75)
    assert fee == round(0.0175 * 0.75 * 0.25, 4)
    win = score(q, "2026-11-20T00:10:00Z", "no")
    assert win["filled"] is True and win["fee"] == fee
    assert abs(win["pnl"] - (1 - 0.75 - fee)) < 1e-9
    loss = score(q, "2026-11-20T00:10:00Z", "yes")
    assert abs(loss["pnl"] + (0.75 + fee)) < 1e-9


def test_score_unfilled_and_void():
    assert score({"side": "yes", "price": 0.7}, None, "yes") == \
        {"filled": False, "fill_ts": None, "result": "yes", "fee": None, "pnl": None}
    v = score({"side": "yes", "price": 0.7}, "2026-11-20T00:10:00Z", "void")
    assert v["filled"] is True and v["pnl"] == 0.0


def row(i, day, pnl, price=0.75, fee=0.0033, market="totals"):
    return {"ticker": f"T{i}", "side": "yes", "market": market, "game_date": day,
            "tip_time": f"{day}T23:30:00+00:00", "price": price, "fee": fee, "pnl": pnl,
            "filled": True, "result": "yes" if pnl > 0 else "no", "scored_at": "x", "queue_ahead": 5}


def test_stop_sample_cuts_at_day_of_nth_fill():
    rows = [row(i, f"2026-12-{1 + i // 100:02d}", 0.2) for i in range(350)]   # 100 fills per day
    s = stop_sample(rows, n=300)
    assert len(s) == 300                       # 300th fill lands on Dec 3, the cut keeps all of Dec 3 (= 300)
    rows2 = [row(i, f"2026-12-{1 + i // 120:02d}", 0.2) for i in range(350)]  # 120/day: 300th on Dec 3
    assert len(stop_sample(rows2, n=300)) == 350   # Dec 1-3 = 350 rows (Dec 3 has 110)


def test_stop_sample_end_date_cap():
    rows = [row(1, "2027-04-10", 0.2), row(2, "2027-04-12", 0.2)]
    assert [r["ticker"] for r in stop_sample(rows, n=300)] == ["T1"]


def test_bar_check_pass_and_fail():
    days = [f"2026-12-{d:02d}" for d in range(1, 31)] + [f"2027-01-{d:02d}" for d in range(1, 31)]
    good = []
    for k, d in enumerate(days):           # 5 fills/day at 0.75: every 3rd day 5 wins, else 4 wins 1 loss
        for j in range(5):                 # (days must differ, or the t-test has zero variance)
            win = j > 0 or k % 3 == 0
            good.append(row(k * 5 + j, d, 0.2467 if win else -0.7533))
    rep = bar_check(good)
    assert rep["n"] == 300 and rep["roi"] > 0.02 and rep["p"] < 0.025 and rep["passes"] is True
    bad = [dict(r, pnl=-0.7533 if i % 4 == 0 else 0.2467) for i, r in enumerate(good)]  # 75% hit at 0.75 -> ~-0.4%
    assert bar_check(bad)["passes"] is False
    assert bar_check(good[:200])["passes"] is False          # under min_n


def test_final_ready():
    assert final_ready(300, date(2026, 12, 1)) is True
    assert final_ready(10, date(2027, 4, 12)) is True
    assert final_ready(299, date(2027, 4, 11)) is False


def test_progress_hides_roi():
    rows = [row(1, "2026-12-01", 0.2), dict(row(2, "2026-12-01", 0.0), filled=False, pnl=None),
            dict(row(3, "2026-12-01", 0.0), scored_at=None, filled=None, pnl=None),
            dict(row(4, "2026-12-01", 0.0), result="void", filled=None, pnl=None)]
    p = progress(rows)["totals"]
    assert p == {"orders": 4, "scored": 3, "void": 1, "fill_rate": 1 / 3, "median_queue": 5, "n_filled": 1}
    assert "roi" not in p
```

Check the arithmetic in `test_stop_sample_cuts_at_day_of_nth_fill`:
- **First case, 100 fills per day:** Dec 1 = rows 0–99, Dec 2 = 100–199, Dec 3 = 200–299, Dec 4 = 300–349. The 300th row (index 299) falls on Dec 3, so Dec 1–3 = 300 rows.
- **Second case, 120 fills per day:** Dec 1 = 0–119, Dec 2 = 120–239, Dec 3 = 240–349 (110 rows). Index 299 falls on Dec 3, so the cut keeps all 350 rows.

**Fill rate:** `fill_rate` = filled ÷ scored, with void rows counted in the denominator. That is 1/3 in `test_progress_hides_roi`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `python -m pytest tests/test_kalshi_maker_quotes.py -q`

Expected: an ImportError on `settled_result`.

- [ ] **Step 3: Implement** (append to `maker_quotes.py`; put the new imports at the top of the file)

Add to the top-of-file imports:

```python
from collections import defaultdict
from statistics import median

from scipy import stats

from kalshi_edges.ledger import grade
```

Append:

```python
# --- pre-registered (spec section 5): do not tune after the test starts ---------------------------
MAKER_K = 0.0175
MAKER_BAR = {"min_n": 300, "min_roi": 0.02, "alpha": 0.025}
END_DATE = date(2027, 4, 11)        # last day of the 2026-27 regular season
MARKETS = ("totals", "props")       # H1 primary, H2 secondary
_RESULTS = {"yes": "yes", "no": "no", "scalar": "void"}   # same mapping as ingest._RESULTS


def settled_result(raw):
    """'yes' / 'no' / 'void' for a finalized Kalshi market dict, else None (not settled yet)."""
    if raw.get("status") not in ("finalized", "settled"):
        return None
    return _RESULTS.get(raw.get("result"))


def maker_fee(p):
    return _r(MAKER_K * p * (1 - p))


def score(quote, fill_ts, result):
    """Outcome columns for one paper order. P&L only when filled (void -> 0)."""
    out = {"filled": fill_ts is not None, "fill_ts": fill_ts, "result": result, "fee": None, "pnl": None}
    if fill_ts is not None:
        p = float(quote["price"])
        fee = maker_fee(p)
        _, pnl = grade(quote["side"], p, fee, result)
        out.update(fee=fee, pnl=round(pnl, 6))
    return out


def _filled(rows):
    return [r for r in rows if r.get("filled") and r.get("result") in ("yes", "no")]


def stop_sample(filled, n=MAKER_BAR["min_n"]):
    """Pre-registered sample: through the game date of the n-th fill (by tip time), else
    everything up to END_DATE."""
    rows = sorted([r for r in filled if r["game_date"] <= END_DATE.isoformat()],
                  key=lambda r: (r["tip_time"], r["ticker"], r["side"]))
    if len(rows) >= n:
        cut = rows[n - 1]["game_date"]
        rows = [r for r in rows if r["game_date"] <= cut]
    return rows


def _roi(rows):
    staked = sum(float(r["price"]) + float(r["fee"]) for r in rows)
    return sum(float(r["pnl"]) for r in rows) / staked if staked else 0.0


def bar_check(filled):
    """Pre-registered verdict on one market's stop_sample."""
    rows = stop_sample(_filled(filled))
    n, half = len(rows), len(rows) // 2
    days = defaultdict(list)
    for r in rows:
        days[r["game_date"]].append(float(r["pnl"]))
    means = [sum(v) / len(v) for v in days.values()]
    p = stats.ttest_1samp(means, 0, alternative="greater").pvalue if len(means) > 2 else 1.0
    p = 1.0 if p != p else float(p)   # NaN (zero variance) -> fail
    rep = {"n": n, "days": len(means), "roi": _roi(rows), "roi_first_half": _roi(rows[:half]),
           "roi_second_half": _roi(rows[half:]), "p": p}
    rep["passes"] = bool(n >= MAKER_BAR["min_n"] and rep["roi"] >= MAKER_BAR["min_roi"]
                         and rep["roi_first_half"] > 0 and rep["roi_second_half"] > 0
                         and p < MAKER_BAR["alpha"])
    return rep


def final_ready(n_filled, today):
    return n_filled >= MAKER_BAR["min_n"] or today > END_DATE


def progress(rows):
    """Per market counts only: no ROI before the end point (spec: no peeking)."""
    out = {}
    for m in MARKETS:
        mine = [r for r in rows if r["market"] == m]
        scored = [r for r in mine if r.get("scored_at")]
        out[m] = {"orders": len(mine), "scored": len(scored),
                  "void": sum(r.get("result") == "void" for r in scored),
                  "fill_rate": sum(bool(r.get("filled")) for r in scored) / len(scored) if scored else 0.0,
                  "median_queue": median(float(r["queue_ahead"]) for r in mine) if mine else 0,
                  "n_filled": len(_filled(mine))}
    return out
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `python -m pytest tests/test_kalshi_maker_quotes.py -q`

Expected: `24 passed`. If `test_bar_check_pass_and_fail`'s `bad` case is borderline, check the ROI. A 75% hit rate at 0.75 plus the fee gives about −0.4%, so it must fail the +2% bar.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/maker_quotes.py scripts/tests/test_kalshi_maker_quotes.py
git commit -m "feat(kalshi): maker paper test scoring + pre-registered bar"
```

---

### Task 5: Kalshi I/O helpers and the post step

**Files:**
- Modify: `scripts/kalshi_edges/maker_quotes.py` (append the I/O section)
- Create: `scripts/kalshi_maker_post.py`

- [ ] **Step 1: Append the I/O helpers to `maker_quotes.py`**

```python
# --- Kalshi I/O (public reads only; never orders) ------------------------------------------------
import time  # noqa: E402

import requests  # noqa: E402

from kalshi_edges.market_data import KALSHI_BASE, INGEST_SERIES_STAT, _get  # noqa: E402

TOTALS_SERIES = "KXNBATOTAL"
POST_SERIES = {**{s: "props" for s in INGEST_SERIES_STAT}, TOTALS_SERIES: "totals"}
PAUSE_S = 0.1


def fetch_orderbook(sess, ticker):
    return _get(sess, f"{KALSHI_BASE}/markets/{ticker}/orderbook").json()


def fetch_trades(sess, ticker, min_ts, max_ts):
    """Every trade on ticker in [min_ts, max_ts] (unix s). Live endpoint first, then historical.
    Raises on rate limit / server errors so the caller leaves the order unscored."""
    for path in ("/markets/trades", "/historical/trades"):
        out, cursor = [], None
        while True:
            params = {"ticker": ticker, "limit": 1000, "min_ts": int(min_ts), "max_ts": int(max_ts)}
            if cursor:
                params["cursor"] = cursor
            try:
                d = _get(sess, KALSHI_BASE + path, params=params).json()
            except requests.HTTPError as e:
                if e.response is not None and e.response.status_code == 404:
                    break
                raise
            out += d.get("trades") or []
            cursor = d.get("cursor")
            time.sleep(PAUSE_S)
            if not cursor or not d.get("trades"):
                break
        if out:
            return out
    return []
```

- [ ] **Step 2: Write `scripts/kalshi_maker_post.py`**

```python
"""Pipeline step (kalshi_live, every 15 min): post PAPER resting bids for the Kalshi maker test
(spec 2026-11-19-kalshi-maker-paper-test-design.md). Public reads + Supabase writes only:
this never places a Kalshi order."""
import os, sys, time
from datetime import date, datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests  # noqa: E402
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.history import tips_cache  # noqa: E402
from kalshi_edges.market_data import _dollars, _game_of, fetch_markets  # noqa: E402
from kalshi_edges.maker_quotes import (END_DATE, PAUSE_S, POST_SERIES, eligible_sides, fetch_orderbook,  # noqa: E402
                                       make_quote, tip_for)

if __name__ == '__main__':
    load_env_local()
    now = datetime.now(timezone.utc)
    if now.date() > END_DATE + timedelta(days=1):
        print("kalshi_maker_post: test ended", END_DATE); sys.exit(0)
    sess = requests.Session()
    tips_for = tips_cache(sess)
    since = (now.date() - timedelta(days=2)).isoformat()
    have = {(r["ticker"], r["side"]) for r in
            sb.select_all("kalshi_maker_quotes", f"select=ticker,side&game_date=gte.{since}&order=id")}
    rows, seen, errors = [], 0, 0
    for series, market in POST_SERIES.items():
        try:
            raws = fetch_markets(series, session=sess)
        except Exception as e:  # noqa: BLE001  one bad series must not stop the others
            print("kalshi_maker_post: series", series, type(e).__name__); errors += 1; continue
        for raw in raws:
            gd, away, home = _game_of(raw.get("ticker"))
            if gd is None or gd > END_DATE:
                continue
            try:
                tip = tip_for(tips_for(gd), away, home)
            except Exception:  # noqa: BLE001  ESPN hiccup: skip this run
                errors += 1; continue
            sides = [s for s, _ in eligible_sides(_dollars(raw.get("yes_bid_dollars")),
                                                   _dollars(raw.get("yes_ask_dollars")), now, tip)
                     if (raw["ticker"], s) not in have]
            if not sides:
                continue
            seen += 1
            try:
                book = fetch_orderbook(sess, raw["ticker"])
            except Exception:  # noqa: BLE001  skip this rung this run
                errors += 1; continue
            time.sleep(PAUSE_S)
            for s in sides:
                q = make_quote(raw["ticker"], market, s, book, now, tip, gd.isoformat())
                if q:
                    rows.append(q)
    n = sb.insert_ignore("kalshi_maker_quotes", rows, "ticker,side")
    print(f"kalshi_maker_post: {seen} eligible rungs, {len(rows)} quotes built, {n} new, {errors} errors")
```

- [ ] **Step 3: Smoke-test it with no write**

Run this (it imports and runs the eligibility logic only, without Supabase writes):

```bash
python -c "
import sys; sys.path.insert(0,'.')
from datetime import datetime, timezone
import requests
from kalshi_edges.market_data import fetch_markets, _game_of, _dollars
from kalshi_edges.history import tips_cache
from kalshi_edges.maker_quotes import eligible_sides, tip_for, fetch_orderbook, make_quote
s=requests.Session(); now=datetime.now(timezone.utc); tf=tips_cache(s)
raws=fetch_markets('KXNBATOTAL', session=s); print(len(raws),'open totals')
for r in raws[:40]:
    gd,a,h=_game_of(r['ticker']); tip=tip_for(tf(gd),a,h) if gd else None
    print(r['ticker'], tip, eligible_sides(_dollars(r.get('yes_bid_dollars')),_dollars(r.get('yes_ask_dollars')),now,tip))
"
```

Expected: tickers print with non-None tip times for tonight's games. Sides are non-empty only for games within 3 h of tip. A `None` tip for every ticker means the team-code spellings don't match. Fix that before continuing; check `kalshi_edges/teams.py`.

- [ ] **Step 4: Run the full Python suite**

Run: `python -m pytest tests -q`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/maker_quotes.py scripts/kalshi_maker_post.py
git commit -m "feat(kalshi): kalshi_maker_post step (paper quotes only)"
```

---

### Task 6: Settle step

**Files:**
- Create: `scripts/kalshi_maker_settle.py`

- [ ] **Step 1: Write `scripts/kalshi_maker_settle.py`**

```python
"""Pipeline step (overnight): score PAPER maker quotes (spec 2026-11-19). For each unscored quote whose
tip is 3h+ past: pull the market result and its trades, apply the queue-aware fill rule, write
filled/fill_ts/result/fee/pnl. Idempotent (only scored_at IS NULL rows). Quotes still unscorable
after 7 days are voided."""
import os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests  # noqa: E402
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.market_data import fetch_market  # noqa: E402
from kalshi_edges.maker_quotes import _ts, fetch_trades, fill_time, score, settled_result  # noqa: E402

GRACE = timedelta(hours=3)
GIVE_UP = timedelta(days=7)

if __name__ == '__main__':
    load_env_local()
    now = datetime.now(timezone.utc)
    rows = sb.select_all("kalshi_maker_quotes", "select=*&scored_at=is.null&order=id")
    sess = requests.Session()
    results, trades = {}, {}
    done = waiting = voided = 0
    for q in rows:
        tip = _ts(q["tip_time"])
        if now - tip < GRACE:
            continue
        t = q["ticker"]
        try:
            if t not in results:
                results[t] = settled_result(fetch_market(t, session=sess))
            if results[t] is not None and t not in trades:
                lo = min(_ts(r["posted_at"]) for r in rows if r["ticker"] == t)
                trades[t] = fetch_trades(sess, t, lo.timestamp(), tip.timestamp())
        except Exception as e:  # noqa: BLE001  rate limit / transient: retry next night
            print("kalshi_maker_settle:", t, type(e).__name__)
            results.setdefault(t, None)
        if results.get(t) is None or t not in trades:
            if now - tip > GIVE_UP:
                sb.patch("kalshi_maker_quotes", f"id=eq.{q['id']}",
                         {"result": "void", "filled": None, "scored_at": now.isoformat()})
                voided += 1
            else:
                waiting += 1
            continue
        fields = score(q, fill_time(q, trades[t]), results[t])
        fields["scored_at"] = now.isoformat()
        sb.patch("kalshi_maker_quotes", f"id=eq.{q['id']}", fields)
        done += 1
    print(f"kalshi_maker_settle: scored {done}, waiting {waiting}, voided {voided}")
```

- [ ] **Step 2: Check that it imports**

Run: `python -c "import ast,sys; ast.parse(open('kalshi_maker_settle.py').read()); print('ok')"`

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/kalshi_maker_settle.py
git commit -m "feat(kalshi): kalshi_maker_settle step"
```

---

### Task 7: Report CLI

**Files:**
- Create: `scripts/kalshi_maker_report.py`

- [ ] **Step 1: Write it**

```python
"""Kalshi maker paper test report (spec 2026-11-19).

  python kalshi_maker_report.py            progress: counts + fill rate, never ROI
  python kalshi_maker_report.py --final    pre-registered verdict, per market that reached its end point
  python kalshi_maker_report.py --final --force   verdict before the end point (NOT pre-registered)
"""
import argparse, os, sys
from datetime import datetime
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.maker_quotes import MARKETS, MAKER_BAR, END_DATE, bar_check, final_ready, progress  # noqa: E402

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument("--final", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    load_env_local()
    rows = sb.select_all("kalshi_maker_quotes", "select=*&order=id")
    today = datetime.now(ZoneInfo("America/New_York")).date()
    prog = progress(rows)
    print(f"Kalshi maker paper test — bar {MAKER_BAR}, end {END_DATE}")
    for m in MARKETS:
        p = prog[m]
        print(f"{m:7} orders {p['orders']:5d}  scored {p['scored']:5d}  void {p['void']:4d}  "
              f"fill rate {p['fill_rate']:.1%}  median queue {p['median_queue']:.0f}  filled {p['n_filled']}")
    if not a.final:
        sys.exit(0)
    for m in MARKETS:
        ready = final_ready(prog[m]["n_filled"], today)
        if not ready and not a.force:
            print(f"{m}: not at end point yet (n_filled {prog[m]['n_filled']} < {MAKER_BAR['min_n']}, "
                  f"before {END_DATE}) — use --force to peek (breaks pre-registration)")
            continue
        if not ready:
            print("!!! FORCED PEEK — NOT PRE-REGISTERED, DO NOT ACT ON THIS !!!")
        r = bar_check([x for x in rows if x["market"] == m])
        print(f"{m}: n {r['n']} days {r['days']} ROI {r['roi']:+.2%} halves {r['roi_first_half']:+.2%} / "
              f"{r['roi_second_half']:+.2%} p {r['p']:.4f} -> {'PASS' if r['passes'] else 'FAIL'}")
```

- [ ] **Step 2: Run it against the empty table**

Run: `python kalshi_maker_report.py`

Expected: two lines, each with `orders     0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/kalshi_maker_report.py
git commit -m "feat(kalshi): maker paper test report (ROI hidden until end point)"
```

---

### Task 8: Wire into the pipeline

**Files:**
- Modify: `scripts/pipeline/phases.py` (the `overnight` list after `kalshi_model_grade`; the `kalshi_live` list)
- Modify: `scripts/tests/test_pipeline_phases.py:7-10,27`

- [ ] **Step 1: Update the tests first**

In `test_overnight_order`, change the last line of the expected list to:

```python
        'kalshi_settle', 'kalshi_pocket_grade', 'kalshi_model_grade', 'kalshi_maker_settle', 'defense_fresh']
```

Change the `kalshi_live` assertion to:

```python
    assert names('kalshi_live') == ['kalshi_ingest', 'kalshi_model_rungs', 'kalshi_model_log', 'kalshi_pocket_scan',
                                    'kalshi_maker_post']
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `python -m pytest tests/test_pipeline_phases.py -q`

Expected: 2 failures (list mismatch).

- [ ] **Step 3: Add the steps in `phases.py`**

After `Step('kalshi_model_grade', 'kalshi', 'python', 'kalshi_model_grade.py', -1),` add:

```python
        Step('kalshi_maker_settle', 'kalshi', 'python', 'kalshi_maker_settle.py', -1),
```

After `Step('kalshi_pocket_scan', 'kalshi', 'python', 'kalshi_pocket_scan.py', 0),` in `kalshi_live` add:

```python
        Step('kalshi_maker_post', 'kalshi', 'python', 'kalshi_maker_post.py', 0),
```

- [ ] **Step 4: Run the full suite**

Run: `python -m pytest tests -q`

Expected: all pass. `test_kalshi_steps_own_chain_not_critical` still passes because both new steps use the `kalshi` chain and are not critical.

- [ ] **Step 5: Commit**

```bash
git add scripts/pipeline/phases.py scripts/tests/test_pipeline_phases.py
git commit -m "feat(pipeline): run maker paper post (kalshi_live) and settle (overnight)"
```

---

### Task 9: Live check on a game night (after the migration is applied)

- [ ] **Step 1: Run the post step for real within 3 h of a tip**

Run: `python kalshi_maker_post.py`

Expected: something like `kalshi_maker_post: N eligible rungs, M quotes built, M new, 0 errors`, with M > 0.

- [ ] **Step 2: Run it again right away**

Expected: `0 new`, because the (ticker, side) unique key stops duplicates.

- [ ] **Step 3: Inspect the rows** with Supabase `execute_sql`:

```sql
select market, side, count(*), round(avg(price),3), round(avg(queue_ahead)) from kalshi_maker_quotes group by 1,2;
```

Expected: both markets present, prices between 0.60 and 0.90.

- [ ] **Step 4: The next day, run settle**

Run: `python kalshi_maker_settle.py`

Expected: `scored K`, where K is the orders whose tip is more than 3 h past. Spot-check one filled order by hand against `/markets/trades` for its ticker.
