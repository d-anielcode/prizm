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

from kalshi_edges.prob_model import prob_over_line, prob_at_strike, solve_shift

def _normal(mu=20.0, sigma=5.0):
    return Distribution("normal", mu, sigma, None)

def test_prob_over_line_fractional_line_no_continuity():
    # Sportsbook lines are .5 values, which get NO continuity bump. The
    # distribution is symmetric about its mean, so P(X>mu-0.5) and P(X>mu+0.5)
    # are mirror images that sum to 1, and the lower line is the more likely over.
    d = _normal(20, 5)
    p_low = prob_over_line(d, 20.0, 19.5)
    p_high = prob_over_line(d, 20.0, 20.5)
    assert p_low > 0.5 > p_high
    assert p_low + p_high == pytest.approx(1.0, abs=1e-9)

def test_prob_at_strike_monotonic_in_strike():
    d = _normal(25, 6)
    p25 = prob_at_strike(d, 0.0, 25)
    p30 = prob_at_strike(d, 0.0, 30)
    assert p30 < p25

def test_solve_shift_round_trip():
    d = _normal(20, 5)
    true_delta = 3.0
    target = prob_over_line(d, d.mu0 + true_delta, 22.5)
    delta, clamped = solve_shift(d, 22.5, target)
    assert not clamped
    assert delta == pytest.approx(true_delta, abs=0.05)

def test_solve_shift_higher_target_gives_higher_delta():
    d = _normal(20, 5)
    lo, _ = solve_shift(d, 20.5, 0.45)
    hi, _ = solve_shift(d, 20.5, 0.65)
    assert hi > lo

def test_solve_shift_clamps_unreachable_target():
    d = _normal(20, 5)
    delta, clamped = solve_shift(d, 20.5, 0.999999)
    assert clamped is True

def test_prob_at_strike_nbinom_discrete():
    d = Distribution("nbinom", 6.0, 3.0, 4.0)
    p = prob_at_strike(d, 0.0, 6)
    assert 0.0 < p < 1.0

def test_prob_at_strike_1_poisson_boundary():
    # "1+ steal" is the most common milestone; strike-1 = 0 boundary.
    import math
    d = Distribution("poisson", 1.5, math.sqrt(1.5), None)
    # P(X >= 1) = 1 - P(X = 0) = 1 - e^{-1.5}
    assert prob_at_strike(d, 0.0, 1) == pytest.approx(1 - math.exp(-1.5), abs=1e-6)

def test_solve_shift_round_trip_nbinom():
    # Exercise the NB code path in the solver (asymmetric f, recomputed p).
    d = Distribution("nbinom", 6.0, 3.0, 4.0)
    true_delta = 2.0
    target = prob_over_line(d, d.mu0 + true_delta, 7.5)
    delta, clamped = solve_shift(d, 7.5, target)
    assert not clamped
    assert delta == pytest.approx(true_delta, abs=0.3)
