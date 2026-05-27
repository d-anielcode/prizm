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

from confidence_features import season_cushion

def test_season_cushion_positive():
    # avg 25 vs line 20 over → cushion = (25-20)/20 = 0.25
    logs = basic_pts_logs()
    c = season_cushion(logs, stat_type="points", line=20.0, direction="over")
    assert c == pytest.approx(0.25, abs=0.02)

def test_season_cushion_under_flipped():
    # For under: cushion = (line - avg) / line
    logs = basic_pts_logs()  # avg 25
    c = season_cushion(logs, stat_type="points", line=30.0, direction="under")
    assert c == pytest.approx((30-25)/30, abs=0.02)

def test_season_cushion_no_logs():
    assert season_cushion([], stat_type="points", line=20.0, direction="over") is None

from confidence_features import line_value

def test_line_value_soft_line():
    # avg 25, line 22 → "soft" (line below avg by 12%)
    c = line_value(basic_pts_logs(), stat_type="points", line=22.0, direction="over")
    assert c > 0  # positive = favorable for over

def test_line_value_tight_line():
    # avg 25, line 28 → tight for over
    c = line_value(basic_pts_logs(), stat_type="points", line=28.0, direction="over")
    assert c < 0

from confidence_features import home_away

def test_home_away_pure_home():
    # all logs is_home=True, prop is at home → 0 (no differential)
    logs = [{"game_date": "2026-05-20", "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,"blocks":0,
             "steals":1,"pra":35} for _ in range(20)]
    c = home_away(logs, stat_type="points", line=20, direction="over", prop_is_home=True)
    assert c == pytest.approx(0.0, abs=0.05) or c is None or c > 0

def test_home_away_home_better_for_home_prop():
    # Player averages 30 at home, 20 on road. Home prop → favorable for over.
    logs = []
    for i in range(20):
        is_home = i % 2 == 0
        pts = 30 if is_home else 20
        logs.append({"game_date": f"2026-05-{20-i:02d}", "minutes": 30, "points": pts,
                     "is_home": is_home, "matchup": "LAL vs. BOS" if is_home else "LAL @ BOS",
                     "rebounds":5,"assists":5,"fg3m":1,"blocks":0,"steals":1,"pra":pts+11})
    c = home_away(logs, stat_type="points", line=22, direction="over", prop_is_home=True)
    assert c > 0.05  # measurable positive

from confidence_features import vs_opponent

def test_vs_opponent_no_history():
    logs = [{"game_date": "2026-05-20", "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. NYK", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":35}]
    assert vs_opponent(logs, stat_type="points", line=20, direction="over", opponent="BOS") is None

def test_vs_opponent_strong_history():
    logs = [{"game_date": "2026-05-20", "minutes": 30, "points": 35, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":45} for _ in range(3)]
    c = vs_opponent(logs, stat_type="points", line=25, direction="over", opponent="BOS")
    assert c is not None and c > 0

from confidence_features import rest_days
from datetime import date, timedelta

def test_rest_days_b2b():
    # Last game yesterday → b2b → negative
    yesterday = (date(2026, 5, 22) - timedelta(days=1)).isoformat()
    logs = [{"game_date": yesterday, "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":35}]
    c = rest_days(logs, prop_game_date="2026-05-22")
    assert c < 0

def test_rest_days_3day_rest():
    logs = [{"game_date": "2026-05-19", "minutes": 30, "points": 25, "is_home": True,
             "matchup": "LAL vs. BOS", "rebounds":5,"assists":5,"fg3m":1,
             "blocks":0,"steals":1,"pra":35}]
    c = rest_days(logs, prop_game_date="2026-05-22")
    assert c is not None and c >= 0

def test_rest_days_no_logs():
    assert rest_days([], prop_game_date="2026-05-22") is None

from confidence_features import pace, blowout, matchup_edge

def test_pace_above_average():
    c = pace(opponent_pace=102.0, league_avg_pace=100.0)
    assert c is not None and c > 0

def test_pace_below_average():
    c = pace(opponent_pace=96.0, league_avg_pace=100.0)
    assert c < 0

def test_blowout_no_spread():
    assert blowout(spread=None) is None

def test_blowout_competitive():
    c = blowout(spread=-3.0)
    assert abs(c) < 0.05

def test_blowout_lopsided():
    c = blowout(spread=-12.0)
    assert c < 0

def test_matchup_edge_top_defense():
    c = matchup_edge(def_rank=1, dvp_value=2.5, direction="over", league_avg=10.0)
    assert c < 0

def test_matchup_edge_bottom_defense():
    c = matchup_edge(def_rank=30, dvp_value=15.0, direction="over", league_avg=10.0)
    assert c > 0

from confidence_features import opponent_leak, player_bias

def test_opponent_leak_positive():
    c = opponent_leak(leak_value=0.10, direction="over")
    assert c is not None and 0 < c <= 4.0

def test_opponent_leak_cap():
    c = opponent_leak(leak_value=10.0, direction="over")
    assert c == 4.0

def test_opponent_leak_under_flipped():
    c = opponent_leak(leak_value=0.10, direction="under")
    assert c < 0

def test_player_bias_blends_with_sample_size():
    c = player_bias(hit_rate=0.60, sample_count=50, direction="over")
    assert c is not None and c > 0

def test_player_bias_small_sample_dampened():
    c_big   = player_bias(hit_rate=0.70, sample_count=100, direction="over")
    c_small = player_bias(hit_rate=0.70, sample_count=5,   direction="over")
    assert c_big > c_small
