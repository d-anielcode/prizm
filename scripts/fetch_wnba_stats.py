"""
WNBA Stats Fetcher (SP1b)
=========================
Pulls WNBA game logs + team defensive rankings from stats.nba.com via nba_api
(LeagueID 10) and upserts into the wnba_* tables. Separate from fetch_nba_stats.py
so the NBA path is untouched. Run daily before WNBA enrichment (future SP3).

Usage:  python scripts/fetch_wnba_stats.py
"""
from datetime import datetime, timezone

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


# ── I/O + entrypoint (kept out of import path so tests need no env/network) ──
def main():
    import os, sys, time
    import requests

    # Credentials (env vars take priority, fall back to .env.local)
    env = {}
    ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env.local')
    try:
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
    SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY"); sys.exit(1)
    HEADERS = {
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
    }

    def upsert(table, rows, on_conflict):
        if not rows:
            return
        url = f'{SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}'
        for i in range(0, len(rows), 200):
            r = requests.post(url, headers=HEADERS, json=rows[i:i+200], timeout=30)
            if not r.ok:
                print(f'  [supabase] upsert error on {table}: {r.status_code} {r.text[:200]}')

    from nba_api.stats.endpoints import leaguegamelog, leaguedashteamstats
    try:
        from nba_api.stats.library.http import STATS_HEADERS
    except ImportError:
        from nba_api.library.http import STATS_HEADERS
    STATS_HEADERS.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.wnba.com/', 'Origin': 'https://www.wnba.com',
        'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
    })

    SEASON = '2026'
    LEAGUE = '10'

    print('[1/2] WNBA game logs...')
    gl_df = leaguegamelog.LeagueGameLog(
        league_id=LEAGUE, season=SEASON, season_type_all_star='Regular Season',
        player_or_team_abbreviation='P', timeout=30).get_data_frames()[0]
    gl_rows = gl_df.to_dict('records')
    log_rows = [gamelog_row_to_log(r) for r in gl_rows]
    upsert('wnba_player_game_logs', log_rows, 'player_name,game_date')
    print(f'      {len(log_rows)} game-log rows')
    abbr = build_team_abbr_map(gl_rows)

    print('[2/2] WNBA team defense...')
    RANK_COL_MAP = {
        'pts_rank': 'OPP_PTS_RANK', 'reb_rank': 'OPP_REB_RANK', 'ast_rank': 'OPP_AST_RANK',
        'blk_rank': 'OPP_BLK_RANK', 'stl_rank': 'OPP_STL_RANK', 'fg3m_rank': 'OPP_FG3M_RANK',
    }

    def opp(last_n=0):
        kw = dict(league_id_nullable=LEAGUE, season=SEASON, season_type_all_star='Regular Season',
                  measure_type_detailed_defense='Opponent', per_mode_detailed='PerGame', timeout=20)
        if last_n > 0:
            kw['last_n_games'] = last_n
        try:
            return leaguedashteamstats.LeagueDashTeamStats(**kw).get_data_frames()[0]
        except TypeError:
            kw.pop('per_mode_detailed', None)
            return leaguedashteamstats.LeagueDashTeamStats(**kw).get_data_frames()[0]

    def abbr_of(row):
        tid = row.get('TEAM_ID')
        return abbr.get(int(tid)) if tid is not None else None

    df_season = opp(0)
    team_rows = []
    for _, row in df_season.iterrows():
        ab = abbr_of(row)
        if not ab:
            continue
        e = {'team_abbreviation': ab, 'fetched_at': datetime.now(timezone.utc).isoformat()}
        for rc, nc in RANK_COL_MAP.items():
            v = row.get(nc)
            e[rc] = int(v) if v is not None else 15
        team_rows.append(e)

    time.sleep(1)
    df_l15 = opp(15)
    l15 = {}
    for _, row in df_l15.iterrows():
        ab = abbr_of(row)
        if not ab:
            continue
        l15[ab] = {f'{rc}_l15': (int(row[nc]) if row.get(nc) is not None else 15)
                   for rc, nc in RANK_COL_MAP.items()}
    for e in team_rows:
        x = l15.get(e['team_abbreviation'], {})
        for rc in RANK_COL_MAP:
            e[f'{rc}_l15'] = x.get(f'{rc}_l15', e.get(rc, 15))

    time.sleep(1)
    try:
        adv = leaguedashteamstats.LeagueDashTeamStats(
            league_id_nullable=LEAGUE, season=SEASON, season_type_all_star='Regular Season',
            measure_type_detailed_defense='Advanced', per_mode_detailed='PerGame', timeout=20
        ).get_data_frames()[0]
        pace = {}
        for _, r in adv.iterrows():
            ab = abbr_of(r)
            if ab:
                pace[ab] = float(r.get('PACE', 0) or 0)
        for e in team_rows:
            e['pace'] = pace.get(e['team_abbreviation'])
    except Exception as ex:
        print(f'      WARN: pace fetch failed: {ex}')

    upsert('wnba_team_defense_stats', team_rows, 'team_abbreviation')
    print(f'      {len(team_rows)} team defense rows')


if __name__ == '__main__':
    main()
