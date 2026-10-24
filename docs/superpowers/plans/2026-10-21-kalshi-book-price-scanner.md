# Kalshi Book-Price Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find Kalshi NBA player-prop rungs priced below the sportsbooks' de-vigged fair probability (after Kalshi's fee), log them as paper trades in Supabase, grade them from Kalshi settlement, and report ROI/CLV against a pre-registered go-live bar.

**Architecture:** Extends the existing read-only Python edge finder in `scripts/kalshi_edges/`. New pure modules (`fees`, `fair_value`, `scanner`, `ledger` math) are unit-tested; thin I/O wrappers talk to Kalshi's public API and Supabase REST. A CLI (`run_paper.py scan|clv|grade|report`) is run by Windows Task Scheduler on the user's PC with `pythonw.exe`.

**Tech Stack:** Python 3.14 (`python3` on this machine; has numpy/scipy/requests/pytest), Kalshi public REST (no auth), Supabase REST (service key from `.env.local`), pytest.

**Spec:** `docs/superpowers/specs/2026-10-21-kalshi-book-price-scanner-design.md`

**Conventions:**
- Run tests from `C:/Users/dcho0/nbaiqproject/scripts`: `python3 -m pytest tests/<file> -q`
- Imports inside the package use `from kalshi_edges import ...` (tests import the same way; `scripts/tests/conftest.py` puts `scripts/` on `sys.path`).
- Commit after each task; end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/kalshi_edges/market_data.py` | modify | Real series list, stat from series ticker, correct "N+" strike, game date/teams from ticker |
| `scripts/kalshi_edges/fees.py` | create | Kalshi quadratic taker fee; read a series' `fee_multiplier` |
| `scripts/kalshi_edges/fair_value.py` | create | De-vig book odds → fair P(over line) per (player, stat) |
| `scripts/kalshi_edges/prizm_data.py` | modify | Add `slate_with_odds()` (props incl. odds/book/commence_time) |
| `scripts/kalshi_edges/scanner.py` | create | Join fair value ↔ Kalshi rungs, YES/NO edge after fee, filters |
| `scripts/kalshi_edges/ledger.py` | create | Paper-trade rows, grading P&L, CLV, report + go-live bar; Supabase/Kalshi I/O |
| `scripts/kalshi_edges/run_paper.py` | create | CLI `scan [--dry-run] / clv / grade / report`; loads `.env.local`; logs to `.logs/kalshi-paper.log` |
| `supabase/migrations/20261021120000_kalshi_paper_trades.sql` | create | Ledger table (applied by user in SQL editor) |
| `scripts/tests/test_kalshi_market_data.py` | modify | Real-format fixtures |
| `scripts/tests/test_kalshi_fees.py`, `test_kalshi_fair_value.py`, `test_kalshi_scanner.py`, `test_kalshi_ledger.py` | create | Unit tests |
| `scripts/kalshi_edges/README.md` | modify | Paper-trading usage + scheduled tasks |

---

### Task 1: Fix the Kalshi market parser for the live format

Live format (verified 2026-10-21): ticker `KXNBAPTS-26OCT21PHXPOR-PORDLILLARD0-25`, title `"Damian Lillard: 25+ points"`, `strike_type="greater"`, `floor_strike=24.5`. Two existing bugs: `int(24.5)=24` prices "24+" instead of "25+"; PRA titles ("points, rebounds, and assists") classify as rebounds.

**Files:**
- Modify: `scripts/kalshi_edges/market_data.py`
- Test: `scripts/tests/test_kalshi_market_data.py`

- [ ] **Step 1: Write the failing tests** (append to `scripts/tests/test_kalshi_market_data.py`)

```python
from datetime import date
from kalshi_edges.market_data import parse_market, PROP_SERIES, SERIES_STAT

def _live(ticker, title, floor, ask="0.4800", bid="0.3200", vol="12.00"):
    return {"ticker": ticker, "title": title, "yes_sub_title": "",
            "strike_type": "greater", "floor_strike": floor, "cap_strike": None,
            "yes_ask_dollars": ask, "yes_bid_dollars": bid, "volume_fp": vol,
            "status": "active", "close_time": "2026-10-24T02:00:00Z"}

def test_live_points_rung_strike_is_floor_plus_half():
    kp = parse_market(_live("KXNBAPTS-26OCT21PHXPOR-PORDLILLARD0-25", "Damian Lillard: 25+ points", 24.5))
    assert (kp.player, kp.stat, kp.strike) == ("Damian Lillard", "points", 25)
    assert (kp.yes_bid, kp.yes_ask) == (0.32, 0.48)

def test_live_pra_uses_series_not_title_keywords():
    kp = parse_market(_live("KXNBAPRA-26OCT21PHXPOR-PORDLILLARD0-30",
                            "Damian Lillard: 30+ points, rebounds, and assists", 29.5))
    assert kp.stat == "pra" and kp.strike == 30

def test_live_suffix_name_and_game_fields():
    kp = parse_market(_live("KXNBASTL-26OCT21SACLAC-SACDACUFF5-2", "Darius Acuff Jr.: 2+ steals", 1.5))
    assert kp.player == "Darius Acuff Jr."
    assert kp.stat == "steals" and kp.strike == 2
    assert kp.series == "KXNBASTL"
    assert kp.game_date == date(2026, 10, 21)
    assert (kp.away, kp.home) == ("SAC", "LAC")

def test_live_threes_series():
    kp = parse_market(_live("KXNBA3PT-26OCT21SACLAC-LACKWAGLER1-3", "Keaton Wagler: 3+ threes", 2.5))
    assert kp.stat == "three_pointers" and kp.strike == 3

def test_prop_series_covers_seven_stats():
    assert sorted(PROP_SERIES) == sorted(SERIES_STAT)
    assert set(SERIES_STAT.values()) == {"points", "rebounds", "assists", "three_pointers",
                                         "blocks", "steals", "pra"}
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_kalshi_market_data.py -q`
Expected: FAIL with `ImportError: cannot import name 'SERIES_STAT'`

- [ ] **Step 3: Implement** — in `scripts/kalshi_edges/market_data.py`:

Replace the imports and `PROP_SERIES` block (lines 17–25) with:

```python
import math
import re
from dataclasses import dataclass, field
from datetime import date
import requests

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

# One series per stat (live-verified 2026-10-21); each holds every player's
# "N+" rungs for every game. The stat comes from the series, not the title:
# PRA titles ("points, rebounds, and assists") would otherwise match "rebound".
SERIES_STAT = {
    "KXNBAPTS": "points", "KXNBAREB": "rebounds", "KXNBAAST": "assists",
    "KXNBA3PT": "three_pointers", "KXNBABLK": "blocks", "KXNBASTL": "steals",
    "KXNBAPRA": "pra",
}
PROP_SERIES: list[str] = list(SERIES_STAT)
_MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
```

Replace the `KalshiProp` dataclass with (new fields excluded from equality so existing tests keep passing):

```python
@dataclass
class KalshiProp:
    ticker: str
    player: str
    stat: str
    strike: int
    yes_bid: float   # 0..1
    yes_ask: float   # 0..1
    volume: int
    series: str = field(default="", compare=False)
    game_date: date | None = field(default=None, compare=False)
    away: str | None = field(default=None, compare=False)
    home: str | None = field(default=None, compare=False)
```

Add helpers after `_dollars`:

```python
def _series_of(ticker):
    return (ticker or "").split("-")[0]

def _game_of(ticker):
    """'KXNBAPTS-26OCT21PHXPOR-...' -> (date(2026,10,21), 'PHX', 'POR'), else (None, None, None).
    Team codes are 2-3 letters; ambiguous splits (e.g. 5 letters) try 3+2 then 2+3."""
    parts = (ticker or "").split("-")
    if len(parts) < 2:
        return None, None, None
    seg = parts[1]
    m = re.match(r"^(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$", seg)
    if not m or m.group(2) not in _MONTHS:
        return None, None, None
    yy, mon, dd, teams = m.groups()
    d = date(2000 + int(yy), _MONTHS[mon], int(dd))
    if len(teams) == 6:
        return d, teams[:3], teams[3:]
    if len(teams) == 5:
        return d, teams[:3], teams[3:]
    if len(teams) == 4:
        return d, teams[:2], teams[2:]
    return d, None, None
```

Replace `_strike_from` with:

```python
def _strike_from(raw):
    """Milestone N for an "N+" market. Kalshi's live props use strike_type='greater'
    with floor_strike = N - 0.5 (24.5 for "25+"), so N = floor(floor_strike) + 1.
    Other strike types keep the structured value as N."""
    if raw.get("floor_strike") is not None:
        fs = float(raw["floor_strike"])
        return math.floor(fs) + 1 if raw.get("strike_type") == "greater" else int(fs)
    if raw.get("cap_strike") is not None:
        return int(float(raw["cap_strike"]))
    text = f"{raw.get('yes_sub_title') or ''} {raw.get('title') or ''}"
    m = STRIKE_RE.search(text)
    return int(m.group(1)) if m else None
```

Replace `parse_market` with:

```python
def parse_market(raw):
    """Parse one Kalshi market dict into a KalshiProp, or None if not an NBA prop."""
    ticker = raw.get("ticker", "")
    series = _series_of(ticker)
    text = f"{raw.get('title') or ''} {raw.get('yes_sub_title') or ''}"
    stat = SERIES_STAT.get(series) or _classify_stat(text)
    if stat is None:
        return None
    strike = _strike_from(raw)
    if strike is None:
        return None
    player = _extract_player(raw.get("title") or "")
    if not player:
        return None
    ask = _dollars(raw.get("yes_ask_dollars"))
    if ask is None:
        return None
    bid = _dollars(raw.get("yes_bid_dollars")) or 0.0
    volume = int(float(raw.get("volume_fp") or 0))
    gd, away, home = _game_of(ticker)
    return KalshiProp(ticker, player, stat, strike, bid, ask, volume,
                      series=series, game_date=gd, away=away, home=home)

def fetch_market(ticker, session=None):
    """One market by ticker (any status). Returns the raw market dict."""
    sess = session or requests.Session()
    r = sess.get(f"{KALSHI_BASE}/markets/{ticker}", timeout=30)
    r.raise_for_status()
    return r.json()["market"]
```

Also update the module docstring's "STILL PENDING" paragraph to: `Live format confirmed 2026-10-21: one series per stat (SERIES_STAT), titles "Player: N+ stat", strike_type "greater" with floor_strike N-0.5.`

- [ ] **Step 4: Run tests**

Run: `python3 -m pytest tests/test_kalshi_market_data.py tests/test_kalshi_find_edges.py -q`
Expected: all pass (old synthetic fixtures use `strike_type="greater_or_equal"`, so their strikes are unchanged).

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/market_data.py scripts/tests/test_kalshi_market_data.py
git commit -m "fix(kalshi): parse live NBA prop format (series stat, N+ strike, game)"
```

---

### Task 2: Kalshi fee

**Files:**
- Create: `scripts/kalshi_edges/fees.py`
- Test: `scripts/tests/test_kalshi_fees.py`

- [ ] **Step 1: Write the failing test** (`scripts/tests/test_kalshi_fees.py`)

```python
import pytest
from kalshi_edges.fees import taker_fee

def test_quadratic_fee_at_50c():
    assert taker_fee(0.50) == pytest.approx(0.0175)

def test_fee_symmetric_and_small_at_extremes():
    assert taker_fee(0.20) == pytest.approx(taker_fee(0.80))
    assert taker_fee(0.05) == pytest.approx(0.07 * 0.05 * 0.95)

def test_fee_multiplier_scales():
    assert taker_fee(0.50, multiplier=0.5) == pytest.approx(0.00875)

def test_fee_rejects_out_of_range_price():
    with pytest.raises(ValueError):
        taker_fee(1.2)
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_kalshi_fees.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kalshi_edges.fees'`

- [ ] **Step 3: Implement** (`scripts/kalshi_edges/fees.py`)

```python
"""Kalshi taker fee. NBA player-prop series report fee_type='quadratic',
fee_multiplier=1 (verified 2026-10-21): fee = 0.07 * m * p * (1 - p) per contract.
Kalshi rounds the ORDER total up to the cent; we use the unrounded per-contract
value, which matches real orders of 10+ contracts."""
import requests
from kalshi_edges.market_data import KALSHI_BASE

FEE_RATE = 0.07

def taker_fee(price, multiplier=1.0):
    if not 0.0 <= price <= 1.0:
        raise ValueError(f"price out of range: {price}")
    return FEE_RATE * multiplier * price * (1.0 - price)

def fetch_fee_multiplier(series_ticker, session=None):
    """The series' fee_multiplier (defaults to 1.0 if absent)."""
    sess = session or requests.Session()
    r = sess.get(f"{KALSHI_BASE}/series/{series_ticker}", timeout=30)
    r.raise_for_status()
    s = r.json().get("series", {})
    return float(s.get("fee_multiplier") or 1.0)
```

- [ ] **Step 4: Run tests** — `python3 -m pytest tests/test_kalshi_fees.py -q` → 4 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/fees.py scripts/tests/test_kalshi_fees.py
git commit -m "feat(kalshi): quadratic taker fee"
```

---

### Task 3: Fair value from book odds

Props rows (from `props`) look like `{"player_name","stat_type","direction","line","odds","sportsbook","commence_time"}`. There is at most one row per (player, stat, direction) after Prizm's best-line dedup, so a two-sided pair exists only when both directions share a line and book.

**Files:**
- Create: `scripts/kalshi_edges/fair_value.py`
- Test: `scripts/tests/test_kalshi_fair_value.py`

- [ ] **Step 1: Write the failing tests** (`scripts/tests/test_kalshi_fair_value.py`)

```python
import pytest
from kalshi_edges.fair_value import american_to_prob, fair_lines, ONE_SIDED_VIG

def row(name, d, line, odds, book="DraftKings", stat="points", t="2026-10-21T23:00:00+00:00"):
    return {"player_name": name, "stat_type": stat, "direction": d, "line": line,
            "odds": odds, "sportsbook": book, "commence_time": t}

def test_american_to_prob():
    assert american_to_prob(-110) == pytest.approx(110 / 210)
    assert american_to_prob(150) == pytest.approx(0.4)

def test_american_to_prob_rejects_insane():
    for o in (None, 3000, -10000, 50):
        assert american_to_prob(o) is None

def test_two_sided_devig_sums_to_one():
    fl, amb = fair_lines([row("Jayson Tatum", "over", 26.5, -110), row("Jayson Tatum", "under", 26.5, -110)])
    f = fl[("jayson tatum", "points")]
    assert f.p_over == pytest.approx(0.5)
    assert f.devig == "two_sided" and f.line == 26.5 and f.books == "DraftKings"
    assert amb == set()

def test_two_sided_skewed():
    fl, _ = fair_lines([row("A B", "over", 5.5, -150), row("A B", "under", 5.5, 120)])
    po, pu = 150 / 250, 100 / 220
    assert fl[("a b", "points")].p_over == pytest.approx(po / (po + pu))

def test_one_sided_over_subtracts_half_vig():
    fl, _ = fair_lines([row("A B", "over", 5.5, -120)])
    f = fl[("a b", "points")]
    assert f.devig == "one_sided"
    assert f.p_over == pytest.approx(120 / 220 - ONE_SIDED_VIG)

def test_one_sided_under_is_inverted():
    fl, _ = fair_lines([row("A B", "under", 5.5, -120)])
    assert fl[("a b", "points")].p_over == pytest.approx(1 - (120 / 220 - ONE_SIDED_VIG))

def test_mismatched_lines_fall_back_to_one_sided_over():
    fl, _ = fair_lines([row("A B", "over", 5.5, -110), row("A B", "under", 6.5, -110)])
    f = fl[("a b", "points")]
    assert f.devig == "one_sided" and f.line == 5.5

def test_ambiguous_names_reported():
    _, amb = fair_lines([row("Jaylen Williams", "over", 5.5, -110, stat="rebounds"),
                         row("Jalen Williams", "over", 5.5, -110, stat="rebounds")])
    assert amb == set()  # different normalized names -> not ambiguous
    _, amb2 = fair_lines([row("Nikola Jokic", "over", 11.5, -110, stat="rebounds"),
                          row("Nikola Jokić", "under", 11.5, -110, stat="rebounds")])
    assert amb2 == set()  # same player, two spellings -> merged, not ambiguous
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_kalshi_fair_value.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kalshi_edges.fair_value'`

- [ ] **Step 3: Implement** (`scripts/kalshi_edges/fair_value.py`)

```python
"""Fair P(over book line) per (player, stat) from sportsbook odds.

Two-sided: both directions quoted at the same line by the same book -> normalize
the two implied probabilities to sum to 1 (removes the vig); average across books.
One-sided fallback: implied probability minus half a typical vig (ONE_SIDED_VIG),
flagged 'one_sided'. Odds outside -500..+500 (or |odds| < 100) are ignored, matching
isSaneOdds in lib/ev.ts.
"""
from collections import defaultdict
from dataclasses import dataclass
from kalshi_edges.find_edges import normalize_name

ONE_SIDED_VIG = 0.024

@dataclass
class FairLine:
    player_name: str
    stat: str
    line: float
    p_over: float
    devig: str          # 'two_sided' | 'one_sided'
    books: str
    commence_time: str | None

def american_to_prob(odds):
    if odds is None:
        return None
    o = float(odds)
    if abs(o) < 100 or o < -500 or o > 500:
        return None
    return -o / (-o + 100) if o < 0 else 100 / (o + 100)

def fair_lines(props):
    """Return ({(norm_name, stat): FairLine}, ambiguous_keys).

    ambiguous_keys is reserved for future use (distinct players that normalize to
    the same key); spelling variants of one player are merged, not ambiguous."""
    by_key = defaultdict(list)
    for p in props:
        if american_to_prob(p.get("odds")) is None or p.get("line") is None:
            continue
        by_key[(normalize_name(p["player_name"]), p["stat_type"])].append(p)
    out = {}
    for key, rows in by_key.items():
        pairs = defaultdict(dict)
        for r in rows:
            pairs[(r.get("sportsbook"), float(r["line"]))][r["direction"]] = r
        two = []
        for (book, line), sides in pairs.items():
            if "over" in sides and "under" in sides:
                po = american_to_prob(sides["over"]["odds"])
                pu = american_to_prob(sides["under"]["odds"])
                two.append((line, book, po / (po + pu), sides["over"]))
        if two:
            # Use the line quoted two-sided by the most books; average their fair p.
            counts = defaultdict(list)
            for line, book, p, r in two:
                counts[line].append((book, p, r))
            line = max(counts, key=lambda ln: len(counts[ln]))
            entries = counts[line]
            p_over = sum(p for _, p, _ in entries) / len(entries)
            r0 = entries[0][2]
            out[key] = FairLine(r0["player_name"], key[1], line, p_over, "two_sided",
                                ",".join(sorted(b for b, _, _ in entries if b)), r0.get("commence_time"))
            continue
        over = next((r for r in rows if r["direction"] == "over"), None)
        r = over or rows[0]
        p_side = american_to_prob(r["odds"]) - ONE_SIDED_VIG
        p_over = p_side if r["direction"] == "over" else 1.0 - p_side
        out[key] = FairLine(r["player_name"], key[1], float(r["line"]), p_over, "one_sided",
                            r.get("sportsbook") or "", r.get("commence_time"))
    return out, set()
```

- [ ] **Step 4: Run tests** — `python3 -m pytest tests/test_kalshi_fair_value.py -q` → 8 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/fair_value.py scripts/tests/test_kalshi_fair_value.py
git commit -m "feat(kalshi): de-vig sportsbook odds into fair P(over)"
```

---

### Task 4: Scanner (edge + filters)

**Files:**
- Create: `scripts/kalshi_edges/scanner.py`
- Test: `scripts/tests/test_kalshi_scanner.py`

- [ ] **Step 1: Write the failing tests** (`scripts/tests/test_kalshi_scanner.py`)

```python
from datetime import date, datetime, timezone
import pytest
from kalshi_edges.market_data import KalshiProp
from kalshi_edges.fair_value import FairLine
from kalshi_edges.prob_model import Distribution
from kalshi_edges.scanner import Filters, evaluate_rung, scan
from kalshi_edges.fees import taker_fee

NOW = datetime(2026, 10, 21, 20, 0, tzinfo=timezone.utc)
TIP = "2026-10-21T23:00:00+00:00"
DIST = Distribution("normal", 25.0, 6.0, None)

def kp(strike=25, bid=0.30, ask=0.36, stat="points"):
    return KalshiProp(f"KXNBAPTS-26OCT21PHXPOR-X-{strike}", "Damian Lillard", stat, strike, bid, ask, 10,
                      series="KXNBAPTS", game_date=date(2026, 10, 21), away="PHX", home="POR")

def fair(p_over=0.55, line=24.5, t=TIP):
    return FairLine("Damian Lillard", "points", line, p_over, "two_sided", "DraftKings", t)

def test_yes_edge_after_fee():
    c = evaluate_rung(kp(ask=0.40, bid=0.35), fair(), DIST, 1.0, NOW, Filters(min_edge=-1))
    assert c.side == "yes"
    assert c.edge == pytest.approx(c.fair_p - 0.40 - taker_fee(0.40))

def test_no_side_when_yes_is_rich():
    c = evaluate_rung(kp(ask=0.80, bid=0.75), fair(), DIST, 1.0, NOW, Filters(min_edge=-1))
    assert c.side == "no"
    assert c.price == pytest.approx(0.25)
    assert c.edge == pytest.approx(c.fair_p - 0.25 - taker_fee(0.25))

def test_min_edge_filters():
    # YES: 0.55 - 0.52 - fee(0.52) = 0.0125 < 0.03; NO: 0.45 - 0.53 - fee < 0
    assert evaluate_rung(kp(ask=0.52, bid=0.47), fair(), DIST, 1.0, NOW, Filters()) is None

def test_wide_spread_filtered():
    assert evaluate_rung(kp(ask=0.30, bid=0.05), fair(), DIST, 1.0, NOW, Filters(min_edge=-1)) is None

def test_started_game_filtered():
    late = datetime(2026, 10, 21, 23, 5, tzinfo=timezone.utc)
    assert evaluate_rung(kp(ask=0.30, bid=0.26), fair(), DIST, 1.0, late, Filters(min_edge=-1)) is None

def test_far_strike_filtered():
    assert evaluate_rung(kp(strike=40, ask=0.02, bid=0.01), fair(), DIST, 1.0, NOW, Filters(min_edge=-1)) is None

def test_extreme_probability_filtered():
    assert evaluate_rung(kp(strike=12, ask=0.90, bid=0.88), fair(line=11.5, p_over=0.97),
                         DIST, 1.0, NOW, Filters(min_edge=-1, max_sigma=10)) is None

def test_scan_matches_names_and_counts_skips():
    logs = {"damian lillard": [{"points": v, "minutes": 34} for v in (20, 22, 24, 25, 26, 28, 30, 31, 19, 27, 25, 23)]}
    cands, skipped = scan([kp(ask=0.30, bid=0.26), kp(stat="rebounds")],
                          {("damian lillard", "points"): fair()}, logs, {"KXNBAPTS": 1.0}, NOW,
                          Filters(min_edge=-1))
    assert len(cands) == 1 and cands[0].market_ticker.endswith("-25")
    assert skipped["no_book_line"] == 1
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_kalshi_scanner.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kalshi_edges.scanner'`

- [ ] **Step 3: Implement** (`scripts/kalshi_edges/scanner.py`)

```python
"""Kalshi rung vs book fair value: P(yes) via the mean-shift bridge, edge after fee."""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from kalshi_edges import prob_model
from kalshi_edges.fees import taker_fee
from kalshi_edges.find_edges import normalize_name

RECENT_GAMES = 40  # distribution shape from the player's most recent games

@dataclass
class Filters:
    min_edge: float = 0.03
    max_spread: float = 0.10
    min_p: float = 0.10
    max_p: float = 0.90
    max_sigma: float = 1.5

@dataclass
class Candidate:
    market_ticker: str
    series: str
    player_name: str
    stat_type: str
    strike: int
    side: str
    price: float
    fee: float
    fair_p: float
    edge: float
    yes_bid: float
    yes_ask: float
    volume: int
    book_line: float
    book_p_over: float
    devig: str
    books: str
    commence_time: str | None

def _started(commence_time, now):
    if not commence_time:
        return False
    return datetime.fromisoformat(commence_time.replace("Z", "+00:00")) <= now

def evaluate_rung(kp, fair, dist, fee_mult, now, f):
    """Best side (yes/no) for one rung, or None if any filter fails."""
    if _started(fair.commence_time, now):
        return None
    if kp.yes_ask - kp.yes_bid > f.max_spread:
        return None
    if abs(kp.strike - fair.line) > f.max_sigma * dist.sigma:
        return None
    delta, clamped = prob_model.solve_shift(dist, fair.line, fair.p_over)
    if clamped:
        return None
    p_yes = prob_model.prob_at_strike(dist, delta, kp.strike)
    if not f.min_p <= p_yes <= f.max_p:
        return None
    options = [("yes", p_yes, kp.yes_ask)]
    if kp.yes_bid > 0:
        options.append(("no", 1.0 - p_yes, 1.0 - kp.yes_bid))
    best = None
    for side, p, price in options:
        fee = taker_fee(price, fee_mult)
        edge = p - price - fee
        if best is None or edge > best[3]:
            best = (side, p, price, edge, fee)
    side, p, price, edge, fee = best
    if edge < f.min_edge:
        return None
    return Candidate(kp.ticker, kp.series, fair.player_name, kp.stat, kp.strike, side,
                     round(price, 4), round(fee, 4), round(p, 4), round(edge, 4),
                     kp.yes_bid, kp.yes_ask, kp.volume, fair.line, round(fair.p_over, 4),
                     fair.devig, fair.books, fair.commence_time)

def scan(kalshi_props, fair_index, logs_by_player, fee_mults, now, f=None):
    """Return (candidates sorted by edge desc, Counter of skip reasons)."""
    f = f or Filters()
    out, skipped, dists = [], Counter(), {}
    for kp in kalshi_props:
        name = normalize_name(kp.player)
        fair = fair_index.get((name, kp.stat))
        if fair is None:
            skipped["no_book_line"] += 1
            continue
        key = (name, kp.stat)
        if key not in dists:
            try:
                dists[key] = prob_model.fit_distribution(logs_by_player.get(name, [])[:RECENT_GAMES], kp.stat)
            except ValueError:
                dists[key] = None
        if dists[key] is None:
            skipped["few_logs"] += 1
            continue
        c = evaluate_rung(kp, fair, dists[key], fee_mults.get(kp.series, 1.0), now, f)
        if c is None:
            skipped["filtered"] += 1
            continue
        out.append(c)
    out.sort(key=lambda c: c.edge, reverse=True)
    return out, skipped
```

Note: `logs_by_player` lists must be most-recent-first (as `prizm_data.all_logs()` returns).

- [ ] **Step 4: Run tests** — `python3 -m pytest tests/test_kalshi_scanner.py -q` → 8 passed. If `test_extreme_probability_filtered` or `test_far_strike_filtered` fails, check filter order in `evaluate_rung` matches the code above before changing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/scanner.py scripts/tests/test_kalshi_scanner.py
git commit -m "feat(kalshi): scanner - book fair value vs Kalshi rungs, edge after fee"
```

---

### Task 5: Ledger math (grading, CLV, report, go-live bar)

**Files:**
- Create: `scripts/kalshi_edges/ledger.py` (pure functions in this task; I/O in Task 6)
- Test: `scripts/tests/test_kalshi_ledger.py`

- [ ] **Step 1: Write the failing tests** (`scripts/tests/test_kalshi_ledger.py`)

```python
import pytest
from kalshi_edges.ledger import grade, side_mid, report, BAR

def test_grade_win_loss_void():
    assert grade("yes", 0.40, 0.0168, "yes") == (True, pytest.approx(0.60 - 0.0168))
    assert grade("no", 0.30, 0.0147, "yes") == (False, pytest.approx(-0.3147))
    assert grade("yes", 0.40, 0.0168, "void") == (None, 0.0)

def test_side_mid():
    assert side_mid("yes", 0.40, 0.44) == pytest.approx(0.42)
    assert side_mid("no", 0.40, 0.44) == pytest.approx(0.58)

def _r(d, won, pnl, price=0.5, clv=0.52):
    return {"scan_date": d, "won": won, "pnl": pnl, "price": price, "fee": 0.0, "clv_mid": clv,
            "stat_type": "points", "side": "yes"}

def test_report_math_and_bar_fail_on_small_n():
    rows = [_r("2026-10-21", True, 0.5), _r("2026-10-22", False, -0.5), _r("2026-10-23", None, None)]
    rep = report(rows)
    assert rep["n"] == 2 and rep["roi"] == pytest.approx(0.0)
    assert rep["mean_clv"] == pytest.approx(0.02)
    assert rep["passes_bar"] is False

def test_report_bar_pass():
    rows = [_r(f"2026-11-{1 + i // 20:02d}", i % 2 == 0, 0.6 if i % 2 == 0 else -0.5) for i in range(BAR["min_n"])]
    rep = report(rows)
    assert rep["roi"] > BAR["min_roi"]
    assert rep["roi_first_half"] > 0 and rep["roi_second_half"] > 0
    assert rep["passes_bar"] is True
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_kalshi_ledger.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'kalshi_edges.ledger'`

- [ ] **Step 3: Implement** (`scripts/kalshi_edges/ledger.py`)

```python
"""Paper-trade ledger: pure grading/report math + Supabase/Kalshi I/O (below)."""
from collections import defaultdict

# Pre-registered go-live bar (spec). Do not tune after seeing results.
BAR = {"min_n": 300, "min_roi": 0.03}

def grade(side, price, fee, result):
    """(won, pnl per contract). result is Kalshi's 'yes'/'no'; anything else = void."""
    if result not in ("yes", "no"):
        return None, 0.0
    won = result == side
    return won, (1.0 - price - fee) if won else -(price + fee)

def side_mid(side, yes_bid, yes_ask):
    mid = (yes_bid + yes_ask) / 2.0
    return mid if side == "yes" else 1.0 - mid

def _roi(rows):
    staked = sum(r["price"] + r["fee"] for r in rows)
    return sum(r["pnl"] for r in rows) / staked if staked else 0.0

def report(rows):
    graded = sorted([r for r in rows if r.get("won") is not None], key=lambda r: r["scan_date"])
    n = len(graded)
    half = n // 2
    clvs = [r["clv_mid"] - r["price"] for r in graded if r.get("clv_mid") is not None]
    by = defaultdict(list)
    for r in graded:
        by[(r["stat_type"], r["side"])].append(r)
    rep = {
        "n": n,
        "win_rate": sum(r["won"] for r in graded) / n if n else 0.0,
        "roi": _roi(graded),
        "roi_first_half": _roi(graded[:half]),
        "roi_second_half": _roi(graded[half:]),
        "mean_clv": sum(clvs) / len(clvs) if clvs else 0.0,
        "n_clv": len(clvs),
        "by_stat_side": {f"{s}:{d}": (len(v), round(_roi(v), 4)) for (s, d), v in sorted(by.items())},
    }
    rep["passes_bar"] = (n >= BAR["min_n"] and rep["roi"] >= BAR["min_roi"]
                         and rep["roi_first_half"] > 0 and rep["roi_second_half"] > 0
                         and rep["mean_clv"] > 0)
    return rep
```

ROI is P&L divided by total amount staked (price + fee per contract), so it reads as "return per dollar risked".

- [ ] **Step 4: Run tests** — `python3 -m pytest tests/test_kalshi_ledger.py -q` → 4 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/kalshi_edges/ledger.py scripts/tests/test_kalshi_ledger.py
git commit -m "feat(kalshi): paper-trade grading, CLV and go-live report"
```

---

### Task 6: Supabase migration + ledger I/O + slate reader

**Files:**
- Create: `supabase/migrations/20261021120000_kalshi_paper_trades.sql`
- Modify: `scripts/kalshi_edges/ledger.py` (append I/O)
- Modify: `scripts/kalshi_edges/prizm_data.py` (append `slate_with_odds`)

- [ ] **Step 1: Write the migration** (`supabase/migrations/20261021120000_kalshi_paper_trades.sql`) — exactly the SQL from the spec's "Ledger table" section:

```sql
-- Kalshi paper-trade ledger (spec 2026-10-21-kalshi-book-price-scanner-design).
-- Additive; no existing table touched. Apply in the Supabase SQL editor.
CREATE TABLE IF NOT EXISTS kalshi_paper_trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date     date        NOT NULL,
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  market_ticker text        NOT NULL,
  series        text        NOT NULL,
  player_name   text        NOT NULL,
  stat_type     text        NOT NULL,
  strike        numeric     NOT NULL,
  side          text        NOT NULL CHECK (side IN ('yes','no')),
  price         numeric     NOT NULL,
  fee           numeric     NOT NULL,
  fair_p        numeric     NOT NULL,
  edge          numeric     NOT NULL,
  yes_bid       numeric,
  yes_ask       numeric,
  volume        numeric,
  book_line     numeric,
  book_p_over   numeric,
  devig         text        NOT NULL,
  books         text,
  commence_time timestamptz,
  clv_mid       numeric,
  result        text,
  won           boolean,
  pnl           numeric,
  graded_at     timestamptz,
  UNIQUE (market_ticker, side, scan_date)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kalshi_paper_trades TO service_role;
GRANT SELECT ON public.kalshi_paper_trades TO anon, authenticated;
```

- [ ] **Step 2: Append Supabase I/O to `scripts/kalshi_edges/ledger.py`**

```python
import os
from dataclasses import asdict
from datetime import timedelta
from urllib.parse import quote
import requests

TABLE = "kalshi_paper_trades"

def _sb():
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

def insert_candidates(cands, scan_date):
    """Insert scanner Candidates; duplicates (same ticker/side/date) are ignored."""
    if not cands:
        return 0
    url, h = _sb()
    rows = [{**asdict(c), "scan_date": scan_date} for c in cands]
    r = requests.post(f"{url}/{TABLE}?on_conflict=market_ticker,side,scan_date",
                      headers={**h, "Prefer": "resolution=ignore-duplicates,return=representation"},
                      json=rows, timeout=60)
    r.raise_for_status()
    return len(r.json())

def fetch_rows(params):
    url, h = _sb()
    out, offset = [], 0
    while True:
        r = requests.get(f"{url}/{TABLE}?{params}&order=id&limit=1000&offset={offset}", headers=h, timeout=60)
        r.raise_for_status()
        batch = r.json()
        out.extend(batch)
        if len(batch) < 1000:
            return out
        offset += 1000

def update_row(row_id, fields):
    url, h = _sb()
    r = requests.patch(f"{url}/{TABLE}?id=eq.{row_id}", headers=h, json=fields, timeout=60)
    r.raise_for_status()

def _ts(dt):
    """ISO timestamp, URL-encoded (the '+00:00' offset would otherwise read as a space)."""
    return quote(dt.isoformat(), safe="")

def rows_needing_clv(now, window_min=30):
    hi = now + timedelta(minutes=window_min)
    return fetch_rows(f"select=*&clv_mid=is.null&commence_time=gt.{_ts(now)}&commence_time=lte.{_ts(hi)}")

def rows_needing_grade(now, settle_hours=3):
    cutoff = now - timedelta(hours=settle_hours)
    return fetch_rows(f"select=*&graded_at=is.null&commence_time=lt.{_ts(cutoff)}")
```

- [ ] **Step 3: Append `slate_with_odds` to `scripts/kalshi_edges/prizm_data.py`**

```python
def slate_with_odds(game_date):
    """Today's props with prices, for de-vigging. Same commence_time window as todays_props."""
    nxt = (date.fromisoformat(game_date) + timedelta(days=1)).isoformat()
    params = ("select=player_name,stat_type,direction,line,odds,sportsbook,commence_time"
              f"&odds=not.is.null&commence_time=gte.{game_date}&commence_time=lt.{nxt}T12:00:00")
    return _sb_get("props", params)
```

- [ ] **Step 4: Run the whole Kalshi suite** — `python3 -m pytest tests/ -q -k kalshi` → all pass (I/O functions aren't unit-tested; they're exercised in Task 8).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261021120000_kalshi_paper_trades.sql scripts/kalshi_edges/ledger.py scripts/kalshi_edges/prizm_data.py
git commit -m "feat(kalshi): paper-trade table migration + ledger I/O"
```

---

### Task 7: CLI (`run_paper.py`)

**Files:**
- Create: `scripts/kalshi_edges/run_paper.py`

- [ ] **Step 1: Implement** (`scripts/kalshi_edges/run_paper.py`)

```python
r"""Kalshi paper trading: scan | clv | grade | report.

Run from repo `scripts/`:  python3 -m kalshi_edges.run_paper scan --dry-run
Scheduled on the user's PC via pythonw.exe (see README). Loads .env.local itself and
appends to .logs\kalshi-paper.log.
"""
import argparse, logging, os, sys
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def _load_env():
    path = os.path.join(REPO, ".env.local")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

_load_env()  # before importing modules that read env at import time

from kalshi_edges import market_data, prizm_data, ledger  # noqa: E402
from kalshi_edges.fair_value import fair_lines  # noqa: E402
from kalshi_edges.fees import fetch_fee_multiplier  # noqa: E402
from kalshi_edges.find_edges import normalize_name  # noqa: E402
from kalshi_edges.scanner import Filters, scan  # noqa: E402

ET = ZoneInfo("America/New_York")
log = logging.getLogger("kalshi_paper")

def _setup_logging():
    os.makedirs(os.path.join(REPO, ".logs"), exist_ok=True)
    handlers = [logging.FileHandler(os.path.join(REPO, ".logs", "kalshi-paper.log"), encoding="utf-8")]
    if sys.stdout is not None:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)

def cmd_scan(args):
    now = datetime.now(timezone.utc)
    game_date = args.game_date or now.astimezone(ET).date().isoformat()
    props = prizm_data.slate_with_odds(game_date)
    fair, _ = fair_lines(props)
    by_player = defaultdict(list)
    for g in prizm_data.all_logs():  # most recent first
        by_player[normalize_name(g["player_name"])].append(g)
    kalshi = [k for k in market_data.fetch_props() if k.game_date and k.game_date.isoformat() == game_date]
    fee_mults = {s: fetch_fee_multiplier(s) for s in market_data.PROP_SERIES}
    cands, skipped = scan(kalshi, fair, by_player, fee_mults, now, Filters(min_edge=args.min_edge))
    log.info("scan %s: %d book lines, %d Kalshi rungs, %d candidates, skipped %s",
             game_date, len(fair), len(kalshi), len(cands), dict(skipped))
    for c in cands[:40]:
        log.info("  %-24s %-14s %3d+ %-3s price %.2f fair %.3f edge %+.3f (%s)",
                 c.player_name, c.stat_type, c.strike, c.side, c.price, c.fair_p, c.edge, c.devig)
    if args.dry_run:
        log.info("dry run: nothing written")
        return 0
    log.info("inserted %d paper trades", ledger.insert_candidates(cands, game_date))
    return 0

def cmd_clv(_args):
    now = datetime.now(timezone.utc)
    rows = ledger.rows_needing_clv(now)
    for r in rows:
        m = market_data.fetch_market(r["market_ticker"])
        bid, ask = float(m.get("yes_bid_dollars") or 0), float(m.get("yes_ask_dollars") or 0)
        if ask <= 0:
            continue
        ledger.update_row(r["id"], {"clv_mid": round(ledger.side_mid(r["side"], bid, ask), 4)})
    log.info("clv: updated %d rows", len(rows))
    return 0

def cmd_grade(_args):
    now = datetime.now(timezone.utc)
    done = 0
    for r in ledger.rows_needing_grade(now):
        m = market_data.fetch_market(r["market_ticker"])
        if m.get("status") not in ("finalized", "settled"):
            continue
        won, pnl = ledger.grade(r["side"], float(r["price"]), float(r["fee"]), m.get("result"))
        ledger.update_row(r["id"], {"result": m.get("result"), "won": won, "pnl": round(pnl, 4),
                                    "graded_at": now.isoformat()})
        done += 1
    log.info("grade: graded %d rows", done)
    return 0

def cmd_report(_args):
    rows = ledger.fetch_rows("select=*")
    for r in rows:
        for k in ("price", "fee", "pnl", "clv_mid"):
            if r.get(k) is not None:
                r[k] = float(r[k])
    rep = ledger.report(rows)
    log.info("report: %s", rep)
    log.info("go-live bar (n>=%d, ROI>=%.0f%%, both halves >0, CLV>0): %s",
             ledger.BAR["min_n"], ledger.BAR["min_roi"] * 100, "PASS" if rep["passes_bar"] else "not met")
    return 0

def main(argv=None):
    _setup_logging()
    ap = argparse.ArgumentParser(description="Kalshi paper trading")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--game-date")
    s.add_argument("--min-edge", type=float, default=0.03)
    sub.add_parser("clv"); sub.add_parser("grade"); sub.add_parser("report")
    args = ap.parse_args(argv)
    try:
        return {"scan": cmd_scan, "clv": cmd_clv, "grade": cmd_grade, "report": cmd_report}[args.cmd](args)
    except Exception:
        log.exception("%s failed", args.cmd)
        return 1

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Import check**

Run: `cd scripts && python3 -c "import kalshi_edges.run_paper"`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/kalshi_edges/run_paper.py
git commit -m "feat(kalshi): run_paper CLI (scan/clv/grade/report)"
```

---

### Task 8: Live dry run and review

- [ ] **Step 1: Dry-run against the live board** (on a game day, before first tip)

Run: `cd scripts && python3 -m kalshi_edges.run_paper scan --dry-run`
Expected: a `scan YYYY-MM-DD: N book lines, M Kalshi rungs, K candidates, skipped {...}` line with M > 0, followed by up to 40 candidate lines.

- [ ] **Step 2: Sanity-check by eye** — for 3 candidates, open the Kalshi market and the DK/FD line: confirm player/stat/strike match, the fair probability is plausible relative to the book line, and the side/price agree with the live ask. Any mismatch → fix the parser/bridge with a regression test before going further.

- [ ] **Step 3: Apply the migration** — the user pastes `supabase/migrations/20261021120000_kalshi_paper_trades.sql` into the Supabase SQL editor. Verify: `curl` `GET /rest/v1/kalshi_paper_trades?select=id&limit=1` returns `[]` (HTTP 200).

- [ ] **Step 4: Real scan** — `python3 -m kalshi_edges.run_paper scan` → `inserted K paper trades`; re-run → `inserted 0` (dedup works).

---

### Task 9: Schedule on the user's PC + docs

- [ ] **Step 1: Register tasks** (PowerShell, same pattern as "Prizm NBA defense refresh"; `pythonw.exe` = no console window):

```powershell
$pyw  = 'C:\Users\dcho0\AppData\Local\Python\pythoncore-3.14-64\pythonw.exe'
$wd   = 'C:\Users\dcho0\nbaiqproject\scripts'
$set  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
function Reg($name, $arg, $trigger) {
  $a = New-ScheduledTaskAction -Execute $pyw -Argument "-m kalshi_edges.run_paper $arg" -WorkingDirectory $wd
  Register-ScheduledTask -TaskName $name -Action $a -Trigger $trigger -Settings $set -Force | Out-Null
}
Reg 'Prizm Kalshi scan'  'scan'  (New-ScheduledTaskTrigger -Daily -At 3:45PM)
$clv = New-ScheduledTaskTrigger -Daily -At 3:55PM
$clv.Repetition = (New-ScheduledTaskTrigger -Once -At 3:55PM -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 4)).Repetition
Reg 'Prizm Kalshi CLV'   'clv'   $clv
Reg 'Prizm Kalshi grade' 'grade' (New-ScheduledTaskTrigger -Daily -At 9:00AM)
Get-ScheduledTask -TaskName 'Prizm Kalshi*' | Select TaskName, State
```

- [ ] **Step 2: Trigger each once** — `Start-ScheduledTask` for scan/clv/grade; confirm new lines in `.logs/kalshi-paper.log` with no `failed` entries.

- [ ] **Step 3: README** — append to `scripts/kalshi_edges/README.md`:

```markdown
## Paper trading (book-price scanner)

Fair value = DraftKings/FanDuel odds with the vig removed, mapped to each Kalshi
"N+" rung via the per-player distribution; edge = fair p − ask − Kalshi fee
(0.07·p·(1−p)). Spec: `docs/superpowers/specs/2026-10-21-kalshi-book-price-scanner-design.md`.

    cd scripts
    python3 -m kalshi_edges.run_paper scan --dry-run   # print candidates only
    python3 -m kalshi_edges.run_paper scan             # write paper trades
    python3 -m kalshi_edges.run_paper clv              # store pre-tip mid (runs every 30 min 3:55-7:55 PM PT)
    python3 -m kalshi_edges.run_paper grade            # settle from Kalshi results
    python3 -m kalshi_edges.run_paper report           # ROI, CLV, go-live bar

Ledger: Supabase `kalshi_paper_trades`. Log: `.logs/kalshi-paper.log`.
Windows tasks: "Prizm Kalshi scan" (3:45 PM), "Prizm Kalshi CLV" (3:55 PM, every 30 min for 4h),
"Prizm Kalshi grade" (9:00 AM), all `pythonw.exe -m kalshi_edges.run_paper ...` in `scripts/`.
Go-live bar (pre-registered): ≥300 graded trades, ROI ≥ +3%, both halves positive, mean CLV > 0.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/kalshi_edges/README.md
git commit -m "docs(kalshi): paper-trading usage and schedule"
git push origin master
```
