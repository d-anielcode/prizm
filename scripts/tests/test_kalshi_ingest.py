from datetime import date
from kalshi_edges.ingest import to_row, collect, settle_updates
from kalshi_edges.market_data import KalshiProp

def _kp(**kw):
    base = dict(ticker="KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25", player="Anthony Edwards",
                stat="points", strike=25, yes_bid=0.44, yes_ask=0.46, volume=900,
                series="KXNBAPTS", game_date=date(2026, 11, 6), away="MIN", home="NOP")
    base.update(kw)
    return KalshiProp(**base)

def test_to_row_maps_fields():
    row = to_row(_kp(), status="active")
    assert row == {"ticker": "KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25", "series": "KXNBAPTS",
                   "stat": "points", "player": "Anthony Edwards", "strike": 25,
                   "game_date": "2026-11-06", "away": "MIN", "home": "NOP",
                   "yes_bid": 0.44, "yes_ask": 0.46, "first_yes_ask": 0.46,
                   "volume": 900, "status": "active"}

def test_to_row_empty_sides_become_null():
    row = to_row(_kp(yes_bid=0.0, yes_ask=1.0), status="active")
    assert row["yes_bid"] is None and row["yes_ask"] is None and row["first_yes_ask"] is None

def test_to_row_skips_missing_game():
    assert to_row(_kp(game_date=None), status="active") is None
    assert to_row(_kp(away=None), status="active") is None

def _raw(ticker, title, series, ask="0.4600", status="active", result=""):
    return {"ticker": ticker, "title": title, "floor_strike": 24.5, "strike_type": "greater",
            "yes_bid_dollars": "0.4400", "yes_ask_dollars": ask, "volume_fp": "900",
            "status": status, "result": result}

def test_collect_parses_and_counts_skips():
    raws = {"KXNBAPTS": [_raw("KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25", "Anthony Edwards: 25+ points", "KXNBAPTS"),
                         _raw("KXNBAPTS-BADTICKER", "Anthony Edwards: 25+ points", "KXNBAPTS"),
                         _raw("KXNBAPTS-26NOV06MINNOP-X", "garbage", "KXNBAPTS")]}
    rows, skipped = collect(lambda s: raws.get(s, []), series=["KXNBAPTS"])
    assert [r["ticker"] for r in rows] == ["KXNBAPTS-26NOV06MINNOP-MINAEDWARDS5-25"]
    assert skipped == 2

def test_settle_updates_groups_by_result_for_one_date():
    raws = [_raw("KXNBAPTS-26NOV06MINNOP-A-25", "A B: 25+ points", "KXNBAPTS", status="finalized", result="yes"),
            _raw("KXNBAPTS-26NOV06MINNOP-C-30", "C D: 30+ points", "KXNBAPTS", status="finalized", result="no"),
            _raw("KXNBAPTS-26NOV07MINNOP-E-30", "E F: 30+ points", "KXNBAPTS", status="finalized", result="no"),
            _raw("KXNBAPTS-26NOV06MINNOP-G-35", "G H: 35+ points", "KXNBAPTS", status="closed", result="")]
    assert settle_updates(raws, date(2026, 11, 6)) == {
        ("finalized", "yes"): ["KXNBAPTS-26NOV06MINNOP-A-25"],
        ("finalized", "no"): ["KXNBAPTS-26NOV06MINNOP-C-30"],
    }
