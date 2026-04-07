"""
Monte Carlo 3-Point Made (3PM) Simulation — Data Fetching Layer
===============================================================
Fetches today's 3PM props from Supabase and player/league shot chart data
from nba_api. No simulation logic yet — this is the data layer only.

Usage:
  py -3.13 scripts/sim_3pm.py
  py -3.13 scripts/sim_3pm.py --dry-run
  py -3.13 scripts/sim_3pm.py --dry-run --n-sims 10000
"""

import os, sys, argparse, time, requests
from datetime import date

try:
    from nba_api.stats.endpoints import shotchartdetail
    from nba_api.stats.static import players as nba_players
    from nba_api.stats.static import teams as nba_teams
except ImportError:
    print("ERROR: nba_api not installed. Run: pip install nba_api")
    sys.exit(1)

# ── Credentials ───────────────────────────────────────────────────────────────
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
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
}

# ── Constants ─────────────────────────────────────────────────────────────────
CURRENT_SEASON = '2025-26'

THREE_PT_ZONES = [
    'Left Corner 3',
    'Right Corner 3',
    'Above the Break 3',
]

# Full team name → NBA abbreviation (matches the-odds-api.io home_team/away_team values)
TEAM_NAME_TO_ABBR = {
    'Atlanta Hawks':          'ATL',
    'Boston Celtics':         'BOS',
    'Brooklyn Nets':          'BKN',
    'Charlotte Hornets':      'CHA',
    'Chicago Bulls':          'CHI',
    'Cleveland Cavaliers':    'CLE',
    'Dallas Mavericks':       'DAL',
    'Denver Nuggets':         'DEN',
    'Detroit Pistons':        'DET',
    'Golden State Warriors':  'GSW',
    'Houston Rockets':        'HOU',
    'Indiana Pacers':         'IND',
    'Los Angeles Clippers':   'LAC',
    'Los Angeles Lakers':     'LAL',
    'Memphis Grizzlies':      'MEM',
    'Miami Heat':              'MIA',
    'Milwaukee Bucks':        'MIL',
    'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans':   'NOP',
    'New York Knicks':        'NYK',
    'Oklahoma City Thunder':  'OKC',
    'Orlando Magic':          'ORL',
    'Philadelphia 76ers':     'PHI',
    'Phoenix Suns':           'PHX',
    'Portland Trail Blazers': 'POR',
    'Sacramento Kings':       'SAC',
    'San Antonio Spurs':      'SAS',
    'Toronto Raptors':        'TOR',
    'Utah Jazz':              'UTA',
    'Washington Wizards':     'WAS',
}

# Build nba_api team_id → abbreviation lookup
_TEAM_LIST = nba_teams.get_teams()
TEAM_ID_TO_ABBR = {t['id']: t['abbreviation'] for t in _TEAM_LIST}


# ── Supabase helpers ──────────────────────────────────────────────────────────
def sb_get_all(table, params=''):
    """Paginate through a Supabase REST endpoint and return all rows."""
    rows = []
    offset = 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=SB_HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows


# ── Data fetching ─────────────────────────────────────────────────────────────
def fetch_todays_3pm_props():
    """
    Query the props table for today's three_pointers props.

    Returns a list of unique (player_name, opponent_abbr, line) dicts,
    deduped by (player_name, opponent_abbr) — keeping the first seen line
    when duplicates exist (multiple sportsbooks).

    Opponent abbreviation is resolved from home_team/away_team fields.
    The props table stores full team names in those columns; the player's
    own team is stored in the `team` column, so the opponent is whichever
    of home_team/away_team doesn't match the player's team.
    """
    today = date.today().strftime('%Y-%m-%d')
    params = (
        f'select=player_name,stat_type,line,direction,team,home_team,away_team'
        f'&stat_type=eq.three_pointers'
        f'&game_date=eq.{today}'
        f'&direction=eq.over'
    )
    print(f'  Querying props table for {today} three_pointers...')
    raw = sb_get_all('props', params)
    print(f'    -> {len(raw)} raw rows (before dedup)')

    seen = {}  # (player_name, opp_abbr) → prop dict
    for row in raw:
        player = row.get('player_name', '')
        line = float(row.get('line', 0) or 0)
        home_full = row.get('home_team', '') or ''
        away_full = row.get('away_team', '') or ''
        player_team_full = row.get('team', '') or ''

        # Determine opponent: the team that is NOT the player's team.
        # home_team/away_team are full names; resolve to abbreviations.
        home_abbr = TEAM_NAME_TO_ABBR.get(home_full, '')
        away_abbr = TEAM_NAME_TO_ABBR.get(away_full, '')
        player_abbr = TEAM_NAME_TO_ABBR.get(player_team_full, '')

        if player_abbr and home_abbr and away_abbr:
            opp_abbr = away_abbr if player_abbr == home_abbr else home_abbr
        elif home_abbr and away_abbr:
            # Fallback: can't determine player team — use home as default context
            opp_abbr = away_abbr
        else:
            # Last resort: try the `opponent` column if available
            opp_abbr = row.get('opponent', '')

        key = (player, opp_abbr)
        if key not in seen:
            seen[key] = {
                'player_name': player,
                'opponent_abbr': opp_abbr,
                'line': line,
                'home_team': home_full,
                'away_team': away_full,
            }

    props = list(seen.values())
    print(f'    -> {len(props)} unique (player, opponent) pairs after dedup')
    return props


def find_nba_player_id(player_name):
    """
    Look up nba_api player ID by full name.

    Tries exact match first, then case-insensitive. Returns None if not found.
    """
    all_players = nba_players.get_players()

    # Exact match
    for p in all_players:
        if p['full_name'] == player_name:
            return p['id']

    # Case-insensitive match
    lower = player_name.lower()
    for p in all_players:
        if p['full_name'].lower() == lower:
            return p['id']

    return None


def fetch_player_shot_chart(player_id):
    """
    Fetch current-season 3-point attempt (3PA) shot chart for a player
    using nba_api ShotChartDetail with context_measure_simple='FG3A'.

    Returns a list of shot dicts filtered to THREE_PT_ZONES only.
    Each dict contains at minimum:
      - SHOT_ZONE_BASIC: zone name
      - LOC_X, LOC_Y: court coordinates
      - SHOT_MADE_FLAG: 1=made, 0=missed
    """
    print(f'  Fetching shot chart for player_id={player_id}...')
    chart = shotchartdetail.ShotChartDetail(
        team_id=0,
        player_id=player_id,
        season_nullable=CURRENT_SEASON,
        season_type_all_star='Regular Season',
        context_measure_simple='FG3A',
        timeout=30,
    )
    df = chart.get_data_frames()[0]

    # Filter to 3-point zones only
    df_3pt = df[df['SHOT_ZONE_BASIC'].isin(THREE_PT_ZONES)]
    shots = df_3pt.to_dict('records')
    print(f'    -> {len(shots)} 3PA shots (all zones), {len(df_3pt)} after zone filter')
    return shots


def fetch_league_shot_chart():
    """
    Fetch league-wide 3-point attempt (3PA) shot chart for the current season.
    Uses player_id=0 and team_id=0 to get all players' shots.

    Returns a list of shot dicts filtered to THREE_PT_ZONES only.
    """
    print('  Fetching league-wide shot chart...')
    chart = shotchartdetail.ShotChartDetail(
        team_id=0,
        player_id=0,
        season_nullable=CURRENT_SEASON,
        season_type_all_star='Regular Season',
        context_measure_simple='FG3A',
        timeout=60,
    )
    df = chart.get_data_frames()[0]

    df_3pt = df[df['SHOT_ZONE_BASIC'].isin(THREE_PT_ZONES)]
    shots = df_3pt.to_dict('records')
    print(f'    -> {len(df_3pt)} league 3PA shots after zone filter')
    return shots


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Monte Carlo 3PM simulation (data layer)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Fetch and print data only; do not run simulations')
    parser.add_argument('--n-sims', type=int, default=10000,
                        help='Number of Monte Carlo simulations per player (default: 10000)')
    args = parser.parse_args()

    print(f'\n3PM Monte Carlo Simulation — Data Fetch')
    print(f'{"="*50}')
    print(f'Season : {CURRENT_SEASON}')
    print(f'N-sims : {args.n_sims}')
    print(f'Dry run: {args.dry_run}')
    print()

    # ── Step 1: Fetch today's 3PM props ──────────────────────────────────────
    print('[1/3] Fetching today\'s 3PM props from Supabase...')
    props = fetch_todays_3pm_props()

    if not props:
        print('  No 3PM props found for today. Exiting.')
        return

    if args.dry_run:
        print('\nSample props:')
        for p in props[:10]:
            print(f'  {p["player_name"]:<25}  opp={p["opponent_abbr"]:<4}  line={p["line"]}')
        if len(props) > 10:
            print(f'  ... and {len(props) - 10} more')
        print()

    # ── Step 2: Resolve player IDs ────────────────────────────────────────────
    print('[2/3] Resolving nba_api player IDs...')
    for prop in props:
        pid = find_nba_player_id(prop['player_name'])
        prop['nba_player_id'] = pid
        if pid is None:
            print(f'  [WARN] Could not find nba_api ID for: {prop["player_name"]}')
        else:
            print(f'  {prop["player_name"]:<25} -> id={pid}')

    resolved = [p for p in props if p['nba_player_id'] is not None]
    skipped  = len(props) - len(resolved)
    if skipped:
        print(f'  [WARN] {skipped} player(s) skipped (no ID match)')

    # ── Step 3: Fetch shot charts ─────────────────────────────────────────────
    print(f'\n[3/3] Fetching shot charts for {len(resolved)} player(s)...')
    for prop in resolved:
        try:
            prop['shot_chart'] = fetch_player_shot_chart(prop['nba_player_id'])
        except Exception as exc:
            print(f'  [ERROR] Shot chart fetch failed for {prop["player_name"]}: {exc}')
            prop['shot_chart'] = []
        time.sleep(0.6)  # be polite to stats.nba.com

    if args.dry_run:
        print('\nShot chart summary:')
        for p in resolved[:10]:
            n = len(p.get('shot_chart', []))
            print(f'  {p["player_name"]:<25}  {n} 3PA shots')
        print()

    # League-wide shot chart (used for prior / smoothing)
    print('Fetching league-wide shot chart...')
    try:
        league_shots = fetch_league_shot_chart()
    except Exception as exc:
        print(f'  [ERROR] League shot chart fetch failed: {exc}')
        league_shots = []

    print(f'\nData fetch complete.')
    print(f'  Props fetched   : {len(props)}')
    print(f'  Players resolved: {len(resolved)}')
    print(f'  League shots    : {len(league_shots)}')

    if args.dry_run:
        print('\n[DRY RUN] Simulation step skipped.')
        return

    # Placeholder: simulation logic will be added in a future task
    print('\n[INFO] Simulation logic not yet implemented.')


if __name__ == '__main__':
    main()
