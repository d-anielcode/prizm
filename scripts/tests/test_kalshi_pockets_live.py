from datetime import datetime, timedelta, timezone
from kalshi_edges.pockets_live import scan_trades, grade_updates

NOW = datetime(2026, 11, 8, 0, 0, tzinfo=timezone.utc)

def mk(t, teams="BOSCHA", ask=0.17, bid=0.15, vol=5, strike=20):   # NO costs .85
    return {"ticker": f"KXNBAPTS-26NOV07{teams}-{t}-{strike}", "player": "A B", "stat": "points", "strike": strike,
            "game_date": "2026-11-07", "yes_bid": bid, "yes_ask": ask, "volume": vol}

def test_scan_only_games_tipping_within_30_minutes():
    tips = {"BOSCHA": NOW + timedelta(minutes=30), "MINNOP": NOW + timedelta(minutes=31)}
    rows = [mk("x"), mk("y", teams="MINNOP")]
    out = scan_trades(rows, tips, NOW, active={"no|band:.80-.90", "yes|band:.10-.20"})
    assert {(o["ticker"].split("-")[2], o["pocket_id"], o["side"]) for o in out} == {
        ("x", "no|band:.80-.90", "no"), ("x", "yes|band:.10-.20", "yes")}   # YES at .17
    o = next(o for o in out if o["side"] == "no")
    assert abs(o["price"] - 0.85) < 1e-9 and o["game_date"] == "2026-11-07"

def test_scan_skips_tipped_games():
    out = scan_trades([mk("x")], {"BOSCHA": NOW - timedelta(minutes=1)}, NOW, active={"no|band:.80-.90"})
    assert out == []

def test_grade_updates():
    trades = [{"id": 1, "ticker": "a", "side": "yes", "price": 0.4, "fee": 0.0168},
              {"id": 2, "ticker": "b", "side": "no", "price": 0.6, "fee": 0.0168},
              {"id": 3, "ticker": "c", "side": "yes", "price": 0.4, "fee": 0.0168},
              {"id": 4, "ticker": "d", "side": "yes", "price": 0.4, "fee": 0.0168}]
    results = {"a": "yes", "b": "yes", "c": "void"}
    ups = {u["id"]: u for u in grade_updates(trades, results)}
    assert ups[1]["won"] is True and abs(ups[1]["pnl"] - (1 - 0.4 - 0.0168)) < 1e-9
    assert ups[2]["won"] is False and abs(ups[2]["pnl"] - -(0.6 + 0.0168)) < 1e-9
    assert ups[3] == {"id": 3, "result": "void", "won": None, "pnl": 0.0}
    assert 4 not in ups
