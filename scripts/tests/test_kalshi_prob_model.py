from kalshi_edges.prob_model import stat_values

def _log(minutes, **stats):
    base = {"minutes": minutes, "points": 0, "rebounds": 0, "assists": 0,
            "fg3m": 0, "blocks": 0, "steals": 0, "pra": 0}
    base.update(stats)
    return base

def test_stat_values_maps_three_pointers_to_fg3m():
    logs = [_log(30, fg3m=4), _log(28, fg3m=2)]
    assert stat_values(logs, "three_pointers") == [4.0, 2.0]

def test_stat_values_filters_low_minute_games():
    logs = [_log(30, points=20), _log(3, points=50)]
    assert stat_values(logs, "points") == [20.0]

def test_stat_values_skips_null_stat():
    logs = [_log(30, points=20), {"minutes": 30, "points": None}]
    assert stat_values(logs, "points") == [20.0]

import pytest
from kalshi_edges.prob_model import fit_distribution, Distribution

def _logs(values, stat_key="points", minutes=30):
    return [{"minutes": minutes, stat_key: v} for v in values]

def test_fit_normal_for_points():
    d = fit_distribution(_logs([20, 22, 18, 24, 26, 19, 21, 23, 25, 17]), "points")
    assert d.family == "normal"
    assert d.mu0 == pytest.approx(21.5, abs=0.01)
    assert d.sigma > 0

def test_fit_nbinom_for_overdispersed_count():
    vals = [2, 8, 1, 12, 3, 9, 0, 14, 4, 11]
    d = fit_distribution(_logs(vals, "rebounds"), "rebounds")
    assert d.family == "nbinom"
    assert d.r is not None and d.r > 0

def test_fit_poisson_when_not_overdispersed():
    vals = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]
    d = fit_distribution(_logs(vals, "assists"), "assists")
    assert d.family == "poisson"

def test_fit_raises_on_thin_sample():
    with pytest.raises(ValueError):
        fit_distribution(_logs([20, 22, 18]), "points")
