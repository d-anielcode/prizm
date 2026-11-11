import pytest
from kalshi_edges.market_data import KalshiProp
from kalshi_edges.find_edges import normalize_name, build_prop_index, compute_edge, find_edges

def _calib():
    return {"lookup": [float(i) for i in range(101)], "per_stat": {}}

def _logs(values, key="points", minutes=30):
    return [{"minutes": minutes, key: v} for v in values]

def test_normalize_name_strips_accents_and_suffix():
    assert normalize_name("Luka Dončić") == "luka doncic"
    assert normalize_name("Jaren Jackson Jr.") == "jaren jackson"

def test_build_prop_index_flags_ambiguous_collision():
    props = [
        {"player_name": "John Smith", "stat_type": "points", "direction": "over",
         "line": 20.5, "confidence_score": 70},
        {"player_name": "John  Smith", "stat_type": "points", "direction": "under",
         "line": 19.5, "confidence_score": 60},
    ]
    index, ambiguous = build_prop_index(props)
    assert ("john smith", "points") in ambiguous

def test_build_prop_index_prefers_over_on_dedup():
    # Same player has both an over and an under row for the same stat. The over
    # row must win the (name, stat) slot regardless of input order.
    over = {"player_name": "Jay Doe", "stat_type": "points", "direction": "over",
            "line": 20.5, "confidence_score": 70}
    under = {"player_name": "Jay Doe", "stat_type": "points", "direction": "under",
             "line": 20.5, "confidence_score": 60}
    idx_a, amb_a = build_prop_index([over, under])
    idx_b, amb_b = build_prop_index([under, over])
    assert idx_a[("jay doe", "points")]["direction"] == "over"
    assert idx_b[("jay doe", "points")]["direction"] == "over"
    assert not amb_a and not amb_b   # same raw name -> not ambiguous

def test_compute_edge_unfactored_on_unexpected_direction():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    prop = {"player_name": "LeBron James", "stat_type": "points", "direction": None,
            "line": 24.5, "confidence_score": 80}
    e = compute_edge(kp, prop, _logs([26] * 12), _calib())
    assert e.flag == "unfactored"   # NULL direction can't orient the anchor

def test_compute_edge_unfactored_when_no_prop():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    e = compute_edge(kp, None, _logs([26] * 12), _calib())
    assert e is not None
    assert e.flag == "unfactored"
    assert e.model_p > 0.5

def test_compute_edge_returns_none_on_thin_logs():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    assert compute_edge(kp, None, _logs([26, 26, 26]), _calib()) is None

def test_compute_edge_factored_direction_under():
    kp = KalshiProp("T", "LeBron James", "points", 25, 0.40, 0.45, 1000)
    prop = {"player_name": "LeBron James", "stat_type": "points", "direction": "under",
            "line": 24.5, "confidence_score": 80}
    # Logs with real spread (mean ~25, sigma ~5) so the mean shift can actually move.
    e = compute_edge(kp, prop, _logs([20, 30, 25, 18, 32, 22, 28, 24, 26, 21,
                                      29, 23, 27, 19, 31]), _calib())
    # under@80 -> p_hit .80 -> p_over .20 -> mean shifts DOWN -> low P(>=25)
    assert e.flag in ("factored", "clamped")
    assert e.model_p < 0.5

def test_find_edges_filters_and_sorts():
    # Zero-variance logs at 28 -> model_p == 1.0 for strike 20, so edge == 1 - ask.
    kps = [
        KalshiProp("A", "Big Edge", "points", 20, 0.30, 0.35, 1000),  # edge +0.65 keep
        KalshiProp("B", "Tiny Edge", "points", 20, 0.30, 0.98, 1000), # edge +0.02 drop
        KalshiProp("C", "Low Vol", "points", 20, 0.30, 0.35, 5),      # vol < 100 drop
    ]
    logs_by_player = {
        "big edge": _logs([28] * 15), "tiny edge": _logs([28] * 15),
        "low vol": _logs([28] * 15),
    }
    edges = find_edges(kps, {}, set(), logs_by_player, _calib(),
                       min_edge=0.05, min_volume=100)
    assert [e.player for e in edges] == ["Big Edge"]   # Tiny Edge < min_edge, Low Vol < min_volume
