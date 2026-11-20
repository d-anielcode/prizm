import pytest
from kalshi_edges.ledger import grade, side_mid, report, BAR

def test_grade_win_loss_void():
    assert grade("yes", 0.40, 0.0168, "yes") == (True, pytest.approx(0.60 - 0.0168))
    assert grade("no", 0.30, 0.0147, "yes") == (False, pytest.approx(-0.3147))
    assert grade("yes", 0.40, 0.0168, "void") == (None, 0.0)

def test_side_mid():
    assert side_mid("yes", 0.40, 0.44) == pytest.approx(0.42)
    assert side_mid("no", 0.40, 0.44) == pytest.approx(0.58)

def _r(d, won, pnl, price=0.5, clv=0.52):
    return {"scan_date": d, "won": won, "pnl": pnl, "price": price, "fee": 0.0, "clv_mid": clv,
            "stat_type": "points", "side": "yes"}

def test_report_math_and_bar_fail_on_small_n():
    rows = [_r("2026-10-21", True, 0.5), _r("2026-10-22", False, -0.5), _r("2026-10-23", None, None)]
    rep = report(rows)
    assert rep["n"] == 2 and rep["roi"] == pytest.approx(0.0)
    assert rep["mean_clv"] == pytest.approx(0.02)
    assert rep["passes_bar"] is False

def test_report_bar_pass():
    rows = [_r(f"2026-11-{1 + i // 20:02d}", i % 2 == 0, 0.6 if i % 2 == 0 else -0.5) for i in range(BAR["min_n"])]
    rep = report(rows)
    assert rep["roi"] > BAR["min_roi"]
    assert rep["roi_first_half"] > 0 and rep["roi_second_half"] > 0
    assert rep["passes_bar"] is True
