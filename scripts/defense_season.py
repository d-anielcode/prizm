"""Pick which NBA season the team-defense ranks should come from.

Early in a season NBA.com's defense tables cover only the teams that have
played, over one or two games, so ranks are noise (on opening night 2026-27
returned 2 teams). Keep last season's ranks until every team has a real sample.
"""

MIN_TEAMS = 30
MIN_GAMES_PLAYED = 10


def choose_defense_season(current_games_played, season, prev_season,
                          min_teams=MIN_TEAMS, min_gp=MIN_GAMES_PLAYED):
    """current_games_played: GP per team from the current season's table
    (empty if the request failed or the season hasn't started)."""
    gp = [int(g or 0) for g in current_games_played]
    if len(gp) >= min_teams and min(gp) >= min_gp:
        return season
    return prev_season
