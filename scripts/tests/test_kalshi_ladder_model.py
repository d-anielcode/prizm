import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from kalshi_edges.ladder_model import anchor, prior_logs

# Identity-ish calibration: per-stat lookup where score s -> s percent.
CAL = {"lookup": [float(i) for i in range(101)], "per_stat": {}}

def sc(line, direction, score):
    return {"line": line, "direction": direction, "confidence_score": score}

def test_anchor_averages_both_sides():
    # over 60 -> 0.60, under 30 -> P(over) 0.70; mean 0.65
    line, p = anchor([sc(24.5, "over", 60), sc(24.5, "under", 30)], "points", CAL)
    assert line == 24.5 and abs(p - 0.65) < 1e-9

def test_anchor_prefers_two_sided_line_over_closer_one_sided():
    rows = [sc(24.5, "over", 80), sc(24.5, "under", 30),   # two-sided, P(over)=0.75
            sc(29.5, "over", 50)]                           # one-sided, exactly 0.5
    assert anchor(rows, "points", CAL)[0] == 24.5

def test_anchor_two_sided_tie_break_closest_to_half():
    rows = [sc(19.5, "over", 80), sc(19.5, "under", 20),   # 0.80
            sc(24.5, "over", 55), sc(24.5, "under", 45)]   # 0.55
    assert anchor(rows, "points", CAL)[0] == 24.5

def test_anchor_under_only_line():
    line, p = anchor([sc(6.5, "under", 70)], "rebounds", CAL)
    assert line == 6.5 and abs(p - 0.30) < 1e-9

def test_anchor_averages_duplicate_books():
    line, p = anchor([sc(24.5, "over", 60), sc(24.5, "over", 70)], "points", CAL)
    assert abs(p - 0.65) < 1e-9

def test_anchor_none_without_usable_rows():
    assert anchor([], "points", CAL) is None
    assert anchor([sc(24.5, "over", None), sc(24.5, "push", 50)], "points", CAL) is None

def test_prior_logs_strictly_before_and_newest_first():
    logs = [{"game_date": d} for d in ["2026-01-03", "2026-01-01", "2026-01-05", "2026-01-02"]]
    out = prior_logs(logs, "2026-01-03", n=2)
    assert [g["game_date"] for g in out] == ["2026-01-02", "2026-01-01"]
