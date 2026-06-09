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
