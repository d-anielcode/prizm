import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from kalshi_edges.fees import taker_fee
from kalshi_edges.ladder_replay import (pick_side, replay, verdict, replay_complete, render_report,
                                        brier, calibration_bins, summarize)

CAL = {"lookup": [float(i) for i in range(101)], "per_stat": {}}
PTS = [18, 22, 25, 30, 21, 27, 24, 19, 26, 23, 28, 20, 25, 22, 31]

def test_pick_side_yes_no_and_filters():
    s = pick_side(0.70, 0.60, 0.62)
    assert s[0] == "yes" and s[1] == 0.62 and abs(s[3] - (0.70 - 0.62 - taker_fee(0.62))) < 1e-12
    s = pick_side(0.30, 0.40, 0.42)
    assert s[0] == "no" and s[1] == 0.6
    assert pick_side(0.70, 0.50, 0.62) is None        # spread 12c
    assert pick_side(0.90, 0.60, 0.62) is None        # gap > 0.10
    assert pick_side(0.99, 0.96, 0.97) is None        # price > 0.95
    assert pick_side(0.70, None, 0.62) is None        # one-sided book

def _settled(strike, bid, ask, result, day="2026-04-10", player="Jaylen Brown"):
    return {"ticker": f"T{strike}-{day}", "player": player, "stat": "points", "strike": strike,
            "game_date": day, "season": "2025-26", "pretip_yes_bid": bid, "pretip_yes_ask": ask, "result": result}

def _logs():
    return [{"game_date": f"2026-01-{1 + i:02d}", "minutes": 30, "points": v, "player_name": "Jaylen Brown"}
            for i, v in enumerate(PTS)]

def _grade(line, direction, score, day="2026-04-10"):
    return {"game_date": day, "player_name": "Jaylen Brown", "stat_type": "points",
            "line": line, "direction": direction, "confidence_score": score}

def test_replay_skips_exact_rungs_and_voids():
    settled = [_settled(25, 0.50, 0.52, "yes"),      # exact (24.5 graded): never a trade
               _settled(30, 0.05, 0.07, "no"),       # stretched
               _settled(35, 0.01, 0.03, "void")]     # void: ignored
    out = replay(settled, [_grade(24.5, "over", 55)], _logs(), CAL)
    assert all(t.ticker != "T25-2026-04-10" for t in out["trades"])
    assert all(not t.ticker.startswith("T35") for t in out["trades"])
    assert out["evals"] and all(e["strike"] != 25 for e in out["evals"])

def test_replay_trade_pnl():
    # Model P(30+) is ~0.12 for this fixture, so YES at 5c is a qualifying trade.
    settled = [_settled(30, 0.03, 0.05, "yes")]
    out = replay(settled, [_grade(24.5, "over", 55)], _logs(), CAL)
    assert out["trades"]
    for t in out["trades"]:
        won = (t.side == "yes")
        assert t.won == won
        assert abs(t.pnl - ((1 - t.price - t.fee) if won else -(t.price + t.fee))) < 1e-12

def test_replay_counts_skips():
    out = replay([_settled(30, 0.10, 0.12, "yes", player="Nobody Known")], [], [], CAL)
    assert out["skips"] == {"no_anchor": 1}

class T:
    def __init__(self, day, pnl, price=0.5, fee=0.0175, ticker="x", side="yes"):
        self.game_date, self.pnl, self.price, self.fee, self.ticker, self.side = day, pnl, price, fee, ticker, side

def test_verdict_bar():
    good = [T(f"2026-01-{d:02d}", 0.2 if i % 3 else -0.1, ticker=f"t{i}") for d in range(1, 31) for i in range(12)]
    v = verdict(good)
    assert v["n"] == 360 and v["roi"] >= 0.03 and v["pass"] is True
    assert verdict(good[:299])["pass"] is False                       # n < 300
    flat = [T(f"2026-01-{d:02d}", 0.0, ticker=f"t{i}") for d in range(1, 31) for i in range(12)]
    assert verdict(flat)["pass"] is False                             # roi 0

def test_replay_complete_guard():
    rows = [{"season": "2025-26", "stat": s, "game_date": "2026-04-03"}
            for s in ("points", "rebounds", "assists", "three_pointers", "pra")]
    assert replay_complete(rows) == (True, "")
    assert replay_complete(rows[:3])[0] is False
    late = [{**r, "game_date": "2026-04-20"} for r in rows]
    assert replay_complete(late)[0] is False
    out_of_window = [{**r, "game_date": "2026-03-01"} for r in rows]
    assert replay_complete(out_of_window)[0] is False
    one_late = rows[:4] + [{**rows[4], "game_date": "2026-04-20"}]   # pra starts too late
    assert replay_complete(one_late)[0] is False

def test_replay_ignores_rungs_before_window():
    settled = [_settled(30, 0.03, 0.05, "yes", day="2026-03-31")]
    out = replay(settled, [_grade(24.5, "over", 55, day="2026-03-31")], _logs(), CAL)
    assert out["trades"] == [] and out["evals"] == [] and out["skips"] == {}

def test_empty_book_not_in_evals():
    settled = [_settled(30, 0.0, 1.0, "no")]
    out = replay(settled, [_grade(24.5, "over", 55)], _logs(), CAL)
    assert out["evals"] == [] and out["trades"] == []

def test_summarize_distance_keys():
    class TT(T):
        def __init__(self, d):
            super().__init__("2026-04-10", 0.1); self.distance = d; self.stat = "points"
    out = {"trades": [TT(1.0), TT(-4.0), TT(8.0)], "evals": [], "skips": {}}
    keys = [g["key"] for g in summarize(out, 3)["by_distance"]]
    assert keys == ["3-5", "6+", "<=2"]

def test_brier_and_bins():
    ev = [{"model_p": 0.8, "mid": 0.6, "y": 1, "stat": "points"},
          {"model_p": 0.2, "mid": 0.4, "y": 0, "stat": "points"}]
    b = brier(ev)
    assert abs(b["model"] - 0.04) < 1e-12 and abs(b["market"] - 0.16) < 1e-12 and b["n"] == 2
    bins = calibration_bins(ev)
    assert [x["bin"] for x in bins] == ["0.2-0.3", "0.8-0.9"]

def test_render_report_states_result():
    md = render_report({"verdict": {"n": 0, "roi": 0.0, "roi_h1": 0.0, "roi_h2": 0.0, "p": 1.0, "pass": False},
                        "by_stat": [], "by_distance": [], "brier": {"n": 0, "model": None, "market": None},
                        "calibration": [], "skips": {}, "n_settled": 0})
    assert "FAIL" in md and "discovery" in md.lower()
    assert "2026-04-02" in md and "alt" in md and "2025-12-01" in md
