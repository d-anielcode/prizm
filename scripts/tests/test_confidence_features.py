# scripts/tests/test_confidence_features.py
import pytest
from confidence_features import last20_hit_rate
from tests.fixtures.sample_logs import basic_pts_logs, sparse_logs

def test_last20_hit_rate_over_basic():
    # Player averages 25 pts; line of 22 should hit ~100% over last 20
    rate = last20_hit_rate(basic_pts_logs(), stat_type="points", line=22, direction="over")
    assert rate == pytest.approx(1.0, abs=0.01)

def test_last20_hit_rate_under_basic():
    # Same logs, line=22 under = ~0%
    rate = last20_hit_rate(basic_pts_logs(), stat_type="points", line=22, direction="under")
    assert rate == pytest.approx(0.0, abs=0.01)

def test_last20_hit_rate_at_line():
    # Player avg 25, line 25, over → 0% (must be strictly above)
    rate = last20_hit_rate(basic_pts_logs(), stat_type="points", line=25, direction="over")
    assert rate == pytest.approx(0.0, abs=0.01)

def test_last20_hit_rate_sparse():
    # Only 3 games — should still compute on what's available
    rate = last20_hit_rate(sparse_logs(), stat_type="points", line=15, direction="over")
    assert rate == pytest.approx(1.0)

def test_last20_hit_rate_minutes_filter():
    # Logs with <5 mins must be filtered
    logs = [{"game_date": "2026-05-20", "minutes": 3, "points": 50, "pra": 80,
             "rebounds": 0, "assists": 0, "fg3m": 0, "blocks": 0, "steals": 0,
             "is_home": True, "matchup": "LAL vs. BOS"}]
    rate = last20_hit_rate(logs, stat_type="points", line=10, direction="over")
    assert rate is None  # no qualifying games

from confidence_features import trend
from tests.fixtures.sample_logs import upward_trend_pts_logs

def test_trend_upward():
    # Last 5 = 30 ppg, prior 15 = 22 ppg → strong positive trend
    t = trend(upward_trend_pts_logs(), stat_type="points")
    assert t > 0.10  # at least 10% lift

def test_trend_flat():
    # All games at 25 ppg → trend should be ~0
    t = trend(basic_pts_logs(), stat_type="points")
    assert abs(t) < 0.05

def test_trend_insufficient_data():
    # Need at least 5 recent + 5 prior — sparse_logs has 3
    assert trend(sparse_logs(), stat_type="points") is None
