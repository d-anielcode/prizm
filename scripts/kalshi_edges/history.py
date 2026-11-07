"""Settled Kalshi markets with pre-tip prices -> kalshi_settled (phase 2a study).

Pure helpers first (tested); backfill orchestration + I/O below.
"""
from datetime import date, datetime

from kalshi_edges.market_data import INGEST_SERIES_STAT, parse_market
from kalshi_edges.teams import canon

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
