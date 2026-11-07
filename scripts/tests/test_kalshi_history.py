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



def test_existing_tickers_limited_to_dates(monkeypatch):
    import kalshi_edges.history as h
    from datetime import date
    seen = []
    monkeypatch.setattr(h.sb, "select_all", lambda table, q: seen.append((table, q)) or [{"ticker": "T"}])
    assert h.existing_tickers([date(2026, 11, 5), date(2026, 11, 4)]) == {"T"}
    assert seen[-1] == ("kalshi_settled", "select=ticker&game_date=in.(2026-11-04,2026-11-05)&order=ticker")
    h.existing_tickers()
    assert seen[-1] == ("kalshi_settled", "select=ticker&order=ticker")


def test_process_markets_collects_unmatched_team_strings():
    tip = datetime(2026, 6, 14, 0, 30, tzinfo=timezone.utc)
    raws = [_raw("KXNBAPTS-26JUN13BOSLAL-C-40"), _raw("KXNBAPTS-26JUN13BOSLAL-D-40"),
            _raw("KXNBAPTS-26JUN13NYKSAS-A-40")]
    unmatched, stats = [], BackfillStats()
    process_markets(raws, tips_for=lambda d: {"NYKSAS": tip},
                    candles_for=lambda raw, s, e: [c_hist(TIP - 60, "0.14", "0.05", "2")],
                    existing=set(), stats=stats, unmatched=unmatched)
    assert stats.no_tip == 2 and unmatched == ["BOSLAL"]


def test_dedupe_by_ticker_last_wins():
    from kalshi_edges.history import dedupe_by_ticker
    rows = [{"ticker": "a", "v": 1}, {"ticker": "b", "v": 2}, {"ticker": "a", "v": 3}]
    assert dedupe_by_ticker(rows) == [{"ticker": "b", "v": 2}, {"ticker": "a", "v": 3}]
