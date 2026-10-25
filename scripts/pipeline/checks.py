"""Pure readiness / coverage / gate checks. Each coverage check returns None when OK,
or a short failure message."""
from datetime import datetime, timedelta

MAX_UNRESOLVED_TEAM_SHARE = 0.05
MIN_SPREAD_SHARE = 0.80
DEFENSE_MAX_AGE = timedelta(hours=48)
PRETIP_LEAD = timedelta(minutes=75)


def enrich_coverage(resp, games_today):
    if games_today <= 0:
        return None
    if (resp.get('enriched') or 0) <= 0:
        return 'enriched 0 props on a game day'
    ts = resp.get('teamSources') or {}
    total = sum(ts.get(k, 0) for k in ('roster', 'logs', 'none'))
    if total and ts.get('none', 0) / total > MAX_UNRESOLVED_TEAM_SHARE:
        return f"team unresolved for {ts.get('none')}/{total} players"
    spreads = resp.get('espnSpreadsLoaded') or 0
    if spreads < MIN_SPREAD_SHARE * games_today:
        return f'spread loaded for {spreads}/{games_today} games'
    return None


def results_present(had_games, grades, results):
    if not had_games:
        return None
    if grades <= 0:
        return 'no prop grades for yesterday'
    if results <= 0:
        return 'no prop results for yesterday'
    return None


def _nba_regular_season(now):
    m, d = now.month, now.day
    return m in (11, 12, 1, 2, 3) or (m == 10 and d >= 20) or (m == 4 and d <= 20)


def defense_fresh(newest_fetched_at, now):
    if not newest_fetched_at:
        return 'no defense data'
    if not _nba_regular_season(now):
        return None
    ts = datetime.fromisoformat(newest_fetched_at.replace('Z', '+00:00'))
    if now - ts > DEFENSE_MAX_AGE:
        return f'defense data {(now - ts).total_seconds() / 3600:.0f}h old'
    return None


def in_pretip_window(first_tip, now, already_ok):
    if already_ok or first_tip is None:
        return False
    lead = first_tip - now
    return timedelta(0) < lead <= PRETIP_LEAD


def logs_ready(history_rows, log_rows):
    return history_rows == 0 or log_rows > 0


def wnba_offseason(now):
    return now.month not in (5, 6, 7, 8, 9, 10)
