"""Settled Kalshi markets with pre-tip prices -> kalshi_settled (phase 2a study).

Pure helpers first (tested); backfill orchestration + I/O below.
"""
import time
from dataclasses import dataclass
from datetime import date, datetime

import requests

from kalshi_edges import sb
from kalshi_edges.espn import fetch_tip_index
from kalshi_edges.market_data import (INGEST_SERIES_STAT, KALSHI_BASE, _game_of, _get,
                                      fetch_markets, parse_market)
from kalshi_edges.teams import canon, ticker_teams

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
    bid, ask, vol = pretip
    return {"ticker": kp.ticker, "series": kp.series, "stat": kp.stat, "player": kp.player,
            "strike": kp.strike, "game_date": kp.game_date.isoformat(),
            "away": canon(kp.away) if kp.away else None, "home": canon(kp.home) if kp.home else None,
            "season": season_of(kp.game_date), "tip_time": tip.isoformat(),
            "open_time": _dt(raw["open_time"]).isoformat(),
            "pretip_yes_bid": bid, "pretip_yes_ask": ask, "pretip_volume": vol, "result": result}


# --- backfill orchestration -------------------------------------------------

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
