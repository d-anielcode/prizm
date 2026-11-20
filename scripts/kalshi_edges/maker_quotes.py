"""Kalshi maker (limit-order) forward paper test — spec 2026-11-19-kalshi-maker-paper-test-design.md.

Pure functions first (eligibility, queue, fill rule, scoring, bar); thin Kalshi I/O at
the bottom. PAPER ONLY: nothing here, or in the scripts that use it, places an order.
"""
import time
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import median

import requests
from scipy import stats

from kalshi_edges.ledger import grade
from kalshi_edges.market_data import KALSHI_BASE, INGEST_SERIES_STAT, _get
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


def date_window(now):
    """{ET today - 1, ET today, ET today + 1} for an aware datetime: the only game dates worth an
    ESPN lookup (America/New_York calendar date)."""
    from zoneinfo import ZoneInfo
    d = now.astimezone(ZoneInfo("America/New_York")).date()
    return {d - timedelta(days=1), d, d + timedelta(days=1)}


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


# --- Kalshi I/O (public reads only; never orders) ------------------------------------------------
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
                # 404 = "endpoint doesn't have it" only on the first page; a 404 mid-pagination
                # means a partial result, so re-raise and leave the order unscored.
                if cursor is None and e.response is not None and e.response.status_code == 404:
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
