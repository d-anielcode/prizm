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

from datetime import date
from kalshi_edges.ladder_model import ladder_probs, build_rungs, et_day_window, exact_strikes

def _logs(vals, stat_key="points", start_day=1):
    # one game per day in Jan 2026, 30 minutes each
    return [{"game_date": f"2026-01-{start_day + i:02d}", "minutes": 30, stat_key: v,
             "player_name": "Jaylen Brown"} for i, v in enumerate(vals)]

PTS = [18, 22, 25, 30, 21, 27, 24, 19, 26, 23, 28, 20, 25, 22, 31]

def test_exact_strikes_only_half_lines():
    rows = [sc(24.5, "over", 60), sc(29.5, "under", 40), sc(20.0, "over", 50)]
    assert exact_strikes(rows) == {25, 30}

def test_ladder_probs_monotone_and_matches_anchor():
    from kalshi_edges.prob_model import prob_over_line
    res, why = ladder_probs([sc(24.5, "over", 55), sc(24.5, "under", 45)], _logs(PTS),
                            "points", [15, 20, 25, 30, 35], "2026-02-01", CAL)
    assert why is None
    ps = [res["probs"][s] for s in (15, 20, 25, 30, 35)]
    assert all(a > b for a, b in zip(ps, ps[1:]))
    assert abs(res["probs"][25] - 0.55) < 0.01        # strike 25 == over 24.5
    assert res["exact"] == {15: False, 20: False, 25: True, 30: False, 35: False}

def test_ladder_probs_ignores_games_on_or_after_date():
    # 15 good games, then a 60-point game ON the game date: must not move the fit.
    logs = _logs(PTS) + [{"game_date": "2026-02-01", "minutes": 30, "points": 60, "player_name": "Jaylen Brown"}]
    a, _ = ladder_probs([sc(24.5, "over", 55)], _logs(PTS), "points", [30], "2026-02-01", CAL)
    b, _ = ladder_probs([sc(24.5, "over", 55)], logs, "points", [30], "2026-02-01", CAL)
    assert a["probs"][30] == b["probs"][30]

def test_ladder_probs_skip_reasons():
    assert ladder_probs([], _logs(PTS), "points", [25], "2026-02-01", CAL) == (None, "no_anchor")
    assert ladder_probs([sc(24.5, "over", 55)], _logs(PTS[:5]), "points", [25], "2026-02-01", CAL) == (None, "few_games")

def test_build_rungs_rows_and_skips():
    markets = [
        {"ticker": "T25", "player": "Jaylen Brown", "stat": "points", "strike": 25, "game_date": "2026-02-01"},
        {"ticker": "T30", "player": "Jaylen Brown", "stat": "points", "strike": 30, "game_date": "2026-02-01"},
        {"ticker": "U8", "player": "Nobody Known", "stat": "rebounds", "strike": 8, "game_date": "2026-02-01"},
        {"ticker": "DD", "player": "Jaylen Brown", "stat": "double_double", "strike": 1, "game_date": "2026-02-01"},
    ]
    scored = [{"player_name": "Jaylen Brown", "stat_type": "points", "line": 24.5, "direction": "over",
               "confidence_score": 55, "commence_time": "2026-02-02T00:30:00+00:00"}]
    rows, skips = build_rungs(markets, scored, _logs(PTS), CAL, "2026-02-01", "2026-02-01T23:00:00+00:00")
    by = {r["ticker"]: r for r in rows}
    assert set(by) == {"T25", "T30"}
    assert by["T25"]["exact"] is True and by["T30"]["exact"] is False
    assert by["T30"]["model_p"] < by["T25"]["model_p"]
    assert by["T30"]["commence_time"] == "2026-02-02T00:30:00+00:00"
    assert by["T30"]["computed_at"] == "2026-02-01T23:00:00+00:00"
    assert skips == {"no_anchor": 1}          # DD is not a ladder stat: ignored, not skipped

def test_build_rungs_matches_names_loosely():
    markets = [{"ticker": "T", "player": "Nikola Jokić", "stat": "points", "strike": 25, "game_date": "2026-02-01"}]
    scored = [{"player_name": "Nikola Jokic", "stat_type": "points", "line": 24.5, "direction": "over",
               "confidence_score": 55, "commence_time": None}]
    logs = [{**g, "player_name": "Nikola Jokic"} for g in _logs(PTS)]
    rows, _ = build_rungs(markets, scored, logs, CAL, "2026-02-01", "now")
    assert [r["ticker"] for r in rows] == ["T"]

def test_et_day_window_handles_dst():
    assert et_day_window(date(2026, 11, 11)) == ("2026-11-11T05:00:00+00:00", "2026-11-12T05:00:00+00:00")
    assert et_day_window(date(2026, 10, 21)) == ("2026-10-21T04:00:00+00:00", "2026-10-22T04:00:00+00:00")
