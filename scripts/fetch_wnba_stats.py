"""
WNBA Stats Fetcher (SP1b)
=========================
Pulls WNBA game logs + team defensive rankings from stats.nba.com via nba_api
(LeagueID 10) and upserts into the wnba_* tables. Separate from fetch_nba_stats.py
so the NBA path is untouched. Run daily before WNBA enrichment (future SP3).

Usage:  python scripts/fetch_wnba_stats.py
"""
from datetime import datetime

# ── Pure helpers (no I/O — unit-tested) ──────────────────────────────────────
def _num(v):
    """Coerce an nba_api numeric (often np.int64) or None to a plain number."""
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0

def gamelog_row_to_log(row):
    """Map one LeagueGameLog record -> a wnba_player_game_logs row."""
    pts, reb, ast = _num(row.get('PTS')), _num(row.get('REB')), _num(row.get('AST'))
    matchup = row.get('MATCHUP') or ''
    pid = row.get('PLAYER_ID')
    return {
        'player_name': row.get('PLAYER_NAME'),
        'nba_id':      int(pid) if pid is not None else None,
        'game_date':   str(row.get('GAME_DATE'))[:10],   # LeagueGameLog GAME_DATE is ISO YYYY-MM-DD
        'matchup':     matchup,
        'is_home':     'vs.' in matchup,                 # "LVA vs. SEA" = home; "LVA @ SEA" = away
        'minutes':     _num(row.get('MIN')),
        'points':      pts,
        'rebounds':    reb,
        'assists':     ast,
        'fg3m':        _num(row.get('FG3M')),
        'blocks':      _num(row.get('BLK')),
        'steals':      _num(row.get('STL')),
        'pra':         pts + reb + ast,
        'win':         row.get('WL') == 'W',
    }

def build_team_abbr_map(rows):
    """TEAM_ID -> TEAM_ABBREVIATION from gamelog records (defense rows lack abbr)."""
    out = {}
    for r in rows:
        tid, ab = r.get('TEAM_ID'), r.get('TEAM_ABBREVIATION')
        if tid is not None and ab:
            out[int(tid)] = ab
    return out
