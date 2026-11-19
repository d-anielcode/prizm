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
