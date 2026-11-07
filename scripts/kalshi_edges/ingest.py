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
