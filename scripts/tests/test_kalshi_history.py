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
