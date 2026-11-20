from fetch_wnba_stats import gamelog_row_to_log, build_team_abbr_map

def test_gamelog_row_maps_and_computes_pra_home_win():
    row = {'PLAYER_NAME': "A'ja Wilson", 'PLAYER_ID': 1628886, 'TEAM_ID': 1611661321,
           'TEAM_ABBREVIATION': 'LVA', 'GAME_DATE': '2026-05-08', 'MATCHUP': 'LVA vs. SEA',
           'WL': 'W', 'MIN': 34, 'PTS': 30, 'REB': 10, 'AST': 5, 'FG3M': 2, 'BLK': 1, 'STL': 2}
    out = gamelog_row_to_log(row)
    assert out['player_name'] == "A'ja Wilson"
    assert out['game_date'] == '2026-05-08'
    assert out['points'] == 30 and out['rebounds'] == 10 and out['assists'] == 5
    assert out['fg3m'] == 2 and out['blocks'] == 1 and out['steals'] == 2
    assert out['pra'] == 45
    assert out['minutes'] == 34
    assert out['is_home'] is True
    assert out['win'] is True
    assert out['nba_id'] == 1628886

def test_gamelog_row_away_and_loss():
    row = {'PLAYER_NAME': 'X', 'PLAYER_ID': 1, 'GAME_DATE': '2026-05-09', 'MATCHUP': 'LVA @ SEA',
           'WL': 'L', 'MIN': 20, 'PTS': 5, 'REB': 2, 'AST': 1, 'FG3M': 0, 'BLK': 0, 'STL': 0}
    out = gamelog_row_to_log(row)
    assert out['is_home'] is False
    assert out['win'] is False
    assert out['pra'] == 8

def test_gamelog_row_handles_missing_numeric():
    row = {'PLAYER_NAME': 'Y', 'PLAYER_ID': 2, 'GAME_DATE': '2026-05-09', 'MATCHUP': 'A vs. B',
           'WL': 'W', 'PTS': None}
    out = gamelog_row_to_log(row)
    assert out['points'] == 0 and out['pra'] == 0

def test_build_team_abbr_map_dedups():
    rows = [{'TEAM_ID': 100, 'TEAM_ABBREVIATION': 'NYL'},
            {'TEAM_ID': 200, 'TEAM_ABBREVIATION': 'CON'},
            {'TEAM_ID': 100, 'TEAM_ABBREVIATION': 'NYL'}]
    assert build_team_abbr_map(rows) == {100: 'NYL', 200: 'CON'}
