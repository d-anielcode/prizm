"""Kalshi -> kalshi_markets (Prediction Markets mode, phase 1).

collect() + to_row() are pure (tested); upsert_rows() / apply_settlement() do the
Supabase I/O with the service role. The table's BEFORE UPDATE trigger keeps
first_yes_ask / first_seen_at from the first insert, so every upsert can send them.
"""
import os
from datetime import datetime, time as dtime, timedelta, timezone

import requests

from kalshi_edges.market_data import (INGEST_SERIES_STAT, _game_of, fetch_markets,
                                      parse_market)

TABLE = "kalshi_markets"
PAGE = 500


def _price(v, ok):
    """Round a 0..1 price, or None when missing / not a live quote (ok(v) false)."""
    if v is None:
        return None
    v = float(v)
    return round(v, 4) if ok(v) else None


def to_row(kp, status):
    """KalshiProp -> table row, or None if the ticker has no game date / teams."""
    if kp.game_date is None or not kp.away or not kp.home:
        return None
    ask = _price(kp.yes_ask, lambda v: 0 < v < 1)
    return {"ticker": kp.ticker, "series": kp.series, "stat": kp.stat, "player": kp.player,
            "strike": kp.strike, "game_date": kp.game_date.isoformat(),
            "away": kp.away, "home": kp.home,
            "yes_bid": _price(kp.yes_bid, lambda v: v > 0), "yes_ask": ask, "first_yes_ask": ask,
            "volume": kp.volume, "status": status}


def collect(fetch, series=None):
    """fetch(series_ticker) -> raw market dicts. Returns (rows, skipped_count).
    Rows are unique by ticker (last wins) so one upsert batch never repeats a key."""
    by_ticker, skipped = {}, 0
    for s in (series or list(INGEST_SERIES_STAT)):
        for raw in fetch(s):
            kp = parse_market(raw, INGEST_SERIES_STAT)
            row = to_row(kp, raw.get("status") or "active") if kp else None
            if row is None:
                skipped += 1
            else:
                by_ticker.pop(row["ticker"], None)
                by_ticker[row["ticker"]] = row
    return list(by_ticker.values()), skipped


# Kalshi result -> our result. "scalar" is how Kalshi settles voided markets (DNP etc.).
_RESULTS = {"yes": "yes", "no": "no", "scalar": "void"}


def settle_updates(raws, game_date):
    """Finalized markets for game_date grouped as {(status, result): [tickers]}.
    result is 'yes' / 'no' / 'void'; any other Kalshi result is ignored."""
    out = {}
    for raw in raws:
        gd, _, _ = _game_of(raw.get("ticker"))
        result = _RESULTS.get(raw.get("result"))
        if gd != game_date or raw.get("status") != "finalized" or result is None:
            continue
        out.setdefault(("finalized", result), []).append(raw["ticker"])
    return out


# -- Supabase I/O -------------------------------------------------------------
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
    """PATCH results onto stored rows. Returns rows actually updated: Kalshi lists every
    settled market, but only the ones we ingested exist in the table."""
    url, h = _sb()
    n = 0
    for (status, result), tickers in updates.items():
        for i in range(0, len(tickers), 100):
            chunk = tickers[i:i + 100]
            ids = ",".join(f'"{t}"' for t in chunk)
            r = requests.patch(f"{url}/{TABLE}?ticker=in.({ids})&select=ticker",
                               headers={**h, "Prefer": "return=representation"},
                               json={"status": status, "result": result}, timeout=60)
            r.raise_for_status()
            n += len(r.json())
    return n


def run_ingest(session=None):
    sess = session or requests.Session()
    rows, skipped = collect(lambda s: fetch_markets(s, session=sess))
    return upsert_rows(rows), skipped


def settle_window(game_dates):
    """(min_close_ts, max_close_ts) covering every date: earliest 00:00 UTC .. latest +2 days."""
    lo = datetime.combine(min(game_dates), dtime(0), tzinfo=timezone.utc)
    hi = datetime.combine(max(game_dates), dtime(0), tzinfo=timezone.utc) + timedelta(days=2)
    return lo.timestamp(), hi.timestamp()


def fetch_settled(game_dates, session=None):
    """One settled-markets fetch per series spanning all game_dates."""
    sess = session or requests.Session()
    lo, hi = settle_window(game_dates)
    raws = []
    for s in INGEST_SERIES_STAT:
        raws += fetch_markets(s, session=sess, status="settled", min_close_ts=lo, max_close_ts=hi)
    return raws


def run_settle(game_dates, session=None):
    """Settle several ET game dates (re-PATCHing is idempotent). Returns {date: count}."""
    dates = sorted(set(game_dates))
    raws = fetch_settled(dates, session=session)
    return {d: apply_settlement(settle_updates(raws, d)) for d in dates}
