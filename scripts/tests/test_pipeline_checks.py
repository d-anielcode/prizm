from datetime import datetime, timedelta, timezone
from pipeline.checks import (enrich_coverage, results_present, defense_fresh,
                             in_pretip_window, logs_ready, wnba_offseason)

NOW = datetime(2026, 11, 3, 21, 0, tzinfo=timezone.utc)

def test_enrich_ok():
    r = {'enriched': 400, 'teamSources': {'roster': 150, 'logs': 3, 'none': 2}, 'espnSpreadsLoaded': 9}
    assert enrich_coverage(r, games_today=10) is None

def test_enrich_no_props_on_game_day():
    assert 'enriched' in enrich_coverage({'enriched': 0}, games_today=5)

def test_enrich_no_games_is_fine():
    assert enrich_coverage({'enriched': 0}, games_today=0) is None

def test_enrich_team_coverage_boundary():
    ok = {'enriched': 1, 'teamSources': {'roster': 95, 'logs': 0, 'none': 5}, 'espnSpreadsLoaded': 10}
    bad = {'enriched': 1, 'teamSources': {'roster': 94, 'logs': 0, 'none': 6}, 'espnSpreadsLoaded': 10}
    assert enrich_coverage(ok, 10) is None
    assert 'team' in enrich_coverage(bad, 10)

def test_enrich_spread_boundary():
    base = {'enriched': 1, 'teamSources': {'roster': 10, 'logs': 0, 'none': 0}}
    assert enrich_coverage({**base, 'espnSpreadsLoaded': 8}, 10) is None
    assert 'spread' in enrich_coverage({**base, 'espnSpreadsLoaded': 7}, 10)

def test_results_present():
    assert results_present(had_games=False, grades=0, results=0) is None
    assert results_present(had_games=True, grades=10, results=4) is None
    assert 'grades' in results_present(had_games=True, grades=0, results=4)
    assert 'results' in results_present(had_games=True, grades=10, results=0)

def test_defense_fresh_in_season_and_offseason():
    assert defense_fresh((NOW - timedelta(hours=47)).isoformat(), NOW) is None
    assert 'old' in defense_fresh((NOW - timedelta(hours=49)).isoformat(), NOW)
    july = datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert defense_fresh((july - timedelta(days=30)).isoformat(), july) is None
    assert 'no defense' in defense_fresh(None, NOW)

def test_pretip_window():
    tip = NOW + timedelta(minutes=60)
    assert in_pretip_window(tip, NOW, already_ok=False) is True
    assert in_pretip_window(NOW + timedelta(minutes=80), NOW, already_ok=False) is False
    assert in_pretip_window(NOW - timedelta(minutes=5), NOW, already_ok=False) is False
    assert in_pretip_window(tip, NOW, already_ok=True) is False
    assert in_pretip_window(None, NOW, already_ok=False) is False

def test_logs_ready():
    assert logs_ready(history_rows=0, log_rows=0) is True   # no games -> nothing to wait for
    assert logs_ready(history_rows=500, log_rows=0) is False
    assert logs_ready(history_rows=500, log_rows=200) is True

def test_wnba_offseason():
    assert wnba_offseason(datetime(2026, 11, 3)) is True
    assert wnba_offseason(datetime(2026, 6, 3)) is False
