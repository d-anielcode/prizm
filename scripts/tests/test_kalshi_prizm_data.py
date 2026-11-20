import pytest
from kalshi_edges.prizm_data import apply_calibration

def _table():
    # 101-length arrays of percent values; per_stat overrides global.
    return {
        "lookup": [float(i) for i in range(101)],            # global: score==percent
        "per_stat": {"points": [50.0] * 101},                # points: flat 50%
    }

def test_apply_calibration_uses_per_stat():
    assert apply_calibration(_table(), "points", 80) == pytest.approx(0.50)

def test_apply_calibration_falls_back_to_global():
    assert apply_calibration(_table(), "rebounds", 80) == pytest.approx(0.80)

def test_apply_calibration_interpolates_fractional_score():
    assert apply_calibration(_table(), "rebounds", 80.5) == pytest.approx(0.805)

def test_apply_calibration_clamps_out_of_range():
    assert apply_calibration(_table(), "rebounds", 150) == pytest.approx(1.0)
    assert apply_calibration(_table(), "rebounds", -10) == pytest.approx(0.0)
