"""
NBA IQ — Stats Fetcher
======================
Pulls real NBA game logs and team defensive rankings from stats.nba.com
via nba_api, then upserts into Supabase for use by the confidence engine.

Usage:
    python scripts/fetch_nba_stats.py

Run this once per day (before the enrichment step).
It fetches the last 25 games for each player in today's props,
plus current team defensive rankings for all 30 teams.

Requirements:
    pip install nba_api requests
"""

import os, sys, time, json
from difflib import get_close_matches
from datetime import datetime

# ── Load credentials (env vars take priority, fall back to .env.local) ───────
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
    pass  # Fine — GitHub Actions uses real env vars

# Real env vars (GitHub Actions) override .env.local values
SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY")
    sys.exit(1)

import requests

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
}

def supabase_get(table, params=''):
    url = f'{SUPABASE_URL}/rest/v1/{table}?{params}'
    r = requests.get(url, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()

def supabase_upsert(table, rows, on_conflict=None):
    if not rows:
        return
    url = f'{SUPABASE_URL}/rest/v1/{table}'
    # PostgREST resolves merge-duplicates against the PRIMARY KEY by default.
    # These tables key data on a secondary unique constraint (e.g.
    # team_abbreviation), so we must name the conflict target explicitly or
    # every row inserts a fresh id and 409s on the unique constraint.
    if on_conflict:
        url += f'?on_conflict={on_conflict}'
    # Batch in chunks of 200
    for i in range(0, len(rows), 200):
        chunk = rows[i:i+200]
        r = requests.post(url, headers=HEADERS, json=chunk, timeout=30)
        if not r.ok:
            print(f'  [supabase] upsert error on {table}: {r.status_code} {r.text[:200]}')

# ── NBA API imports ───────────────────────────────────────────────────────────
import argparse
from datetime import date, timedelta

# stats.nba.com blocks requests from cloud IPs without browser-like headers.
# nba_api >=1.3 moved STATS_HEADERS to nba_api.stats.library.http; fall back to
# the legacy location for older installs.
try:
    from nba_api.stats.library.http import STATS_HEADERS
except ImportError:  # pragma: no cover - legacy nba_api
    from nba_api.library.http import STATS_HEADERS
STATS_HEADERS.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.nba.com/',
    'Origin': 'https://www.nba.com',
    'x-nba-stats-origin': 'stats',
    'x-nba-stats-token': 'true',
})

parser = argparse.ArgumentParser()
parser.add_argument('--yesterday', action='store_true',
                    help='Fetch stats for players who played last night (use in morning after overnight games)')
parser.add_argument('--today', action='store_true',
                    help='Fetch stats for players who played today (use at night after games finish ~11pm ET)')
parser.add_argument('--date', type=str, default=None,
                    help='Specific date to pull box scores from (YYYY-MM-DD)')
parser.add_argument('--defense-only', action='store_true',
                    help='Skip game-log fetch (steps 1-3); only refresh team defense + DVP. '
                         'Used in CI where /api/gamelogs handles game logs separately.')
args = parser.parse_args()

from nba_api.stats.static import players as nba_players_static
from nba_api.stats.endpoints import playergamelog, leaguedashteamstats, leaguegamelog, commonteamroster

# Build canonical name → player dict once
_all_players = nba_players_static.get_players()
_name_to_player = {p['full_name'].lower(): p for p in _all_players}

def find_player(name: str):
    """Fuzzy-match a display name to an NBA player record."""
    lower = name.lower().strip()

    # Exact match
    if lower in _name_to_player:
        return _name_to_player[lower]

    # Suffix stripping (Jr., Sr., III, etc.)
    # Handle accented names (Doncic, etc.)
    import unicodedata
    clean = unicodedata.normalize('NFKD', lower).encode('ascii', 'ignore').decode('ascii')
    clean = clean.replace(' jr.','').replace(' sr.','').replace(' ii','').replace(' iii','').replace(' iv','').strip()
    if clean in _name_to_player:
        return _name_to_player[clean]

    # Close fuzzy match
    matches = get_close_matches(lower, _name_to_player.keys(), n=1, cutoff=0.82)
    if matches:
        return _name_to_player[matches[0]]

    return None

def parse_minutes(min_str) -> float:
    try:
        if ':' in str(min_str):
            parts = str(min_str).split(':')
            return round(int(parts[0]) + int(parts[1]) / 60, 2)
        return float(min_str or 0)
    except:
        return 0.0

# ── Season constants (used in Steps 1 and 3) ─────────────────────────────────
SEASON      = '2025-26'
PREV_SEASON = '2024-25'

# ── Step 1: Get player names ──────────────────────────────────────────────────
use_history_mode = args.yesterday or args.today or args.date is not None

if args.defense_only:
    print("\n[defense-only] Skipping game-log fetch (steps 1-3)")
    player_names = []
elif use_history_mode:
    if args.date:
        target_date = args.date
    elif args.today:
        target_date = date.today().strftime('%Y-%m-%d')
    else:
        target_date = (date.today() - timedelta(days=1)).strftime('%Y-%m-%d')

    print(f"\n[1/4] Fetching all players who played on {target_date} via LeagueGameLog...")
    player_names_set = set()
    try:
        lg = leaguegamelog.LeagueGameLog(
            season=SEASON,
            season_type_all_star='Regular Season',
            date_from_nullable=target_date,
            date_to_nullable=target_date,
            player_or_team_abbreviation='P',
            timeout=30,
        )
        df_lg = lg.get_data_frames()[0]
        if not df_lg.empty:
            # Try multiple possible column names across nba_api versions
            possible_cols = ['PLAYER_NAME', 'playerName', 'player_name', 'PLAYER']
            name_col = next((c for c in possible_cols if c in df_lg.columns), None)
            if name_col:
                player_names_set.update(df_lg[name_col].dropna().unique().tolist())
                print(f"      Found {len(player_names_set)} players who played on {target_date}")
            else:
                print(f"      WARNING: unknown columns in LeagueGameLog: {df_lg.columns.tolist()}")
        else:
            print(f"      No games found for {target_date} (games may not be final yet)")
    except Exception as e:
        print(f"      ERROR fetching LeagueGameLog: {e}")
        print(f"      Falling back to existing player_game_logs only")

    # Also include anyone already in game_logs DB so historical data is refreshed too
    known = supabase_get('player_game_logs', 'select=player_name')
    for r in known:
        if r.get('player_name'):
            player_names_set.add(r['player_name'])

    player_names = list(player_names_set)
    print(f"      {len(player_names)} total players to refresh")

else:
    print("\n[1/4] Loading player names from Supabase props...")
    all_prop_rows = []
    offset = 0
    PAGE = 1000
    while True:
        batch = supabase_get('props', f'select=player_name&order=cached_at.desc&limit={PAGE}&offset={offset}')
        if not batch:
            break
        all_prop_rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += PAGE

    player_names = list({p['player_name'] for p in all_prop_rows if p.get('player_name')})
    print(f"      {len(player_names)} unique players across {len(all_prop_rows)} props")

# ── Step 2: Resolve to NBA IDs ────────────────────────────────────────────────
print("\n[2/4] Matching player names to NBA IDs...")
resolved = {}   # name → nba player dict
unmatched = []

for name in player_names:
    player = find_player(name)
    if player:
        resolved[name] = player
    else:
        unmatched.append(name)

print(f"      Matched: {len(resolved)}/{len(player_names)}")
if unmatched:
    print(f"      Unmatched: {unmatched}")

# ── Step 3: Fetch game logs (last 60 games across current + prior season) ─────
print(f"\n[3/4] Fetching up to 60 game logs for {len(resolved)} players...")
all_log_rows = []

for i, (prop_name, player) in enumerate(resolved.items()):
    nba_id = player['id']
    print(f"  [{i+1}/{len(resolved)}] {prop_name} (id={nba_id})", end=' ... ', flush=True)
    try:
        # Fetch current season
        log_curr = playergamelog.PlayerGameLog(
            player_id=nba_id,
            season=SEASON,
            season_type_all_star='Regular Season',
            timeout=30,
        )
        df_curr = log_curr.get_data_frames()[0]
        time.sleep(0.6)

        # Fetch prior season to fill up to 60 games total for better vs-opponent history
        log_prev = playergamelog.PlayerGameLog(
            player_id=nba_id,
            season=PREV_SEASON,
            season_type_all_star='Regular Season',
            timeout=30,
        )
        df_prev = log_prev.get_data_frames()[0]

        # Combine: current season first, then prior — cap at 60 total
        import pandas as pd
        df = pd.concat([df_curr, df_prev], ignore_index=True).head(60)

        if df.empty:
            print("no games found")
            continue

        rows = []
        for _, row in df.iterrows():
            matchup = str(row.get('MATCHUP', ''))
            is_home = 'vs.' in matchup
            pts  = float(row.get('PTS', 0) or 0)
            reb  = float(row.get('REB', 0) or 0)
            ast  = float(row.get('AST', 0) or 0)
            stl  = float(row.get('STL', 0) or 0)
            blk  = float(row.get('BLK', 0) or 0)
            fg3m = float(row.get('FG3M', 0) or 0)
            mins = parse_minutes(row.get('MIN', 0))
            wl   = str(row.get('WL', ''))

            # Convert "MAR 18, 2026" → "2026-03-18" so Supabase sorts chronologically
            raw_date = str(row.get('GAME_DATE', ''))
            try:
                game_date = datetime.strptime(raw_date, '%b %d, %Y').strftime('%Y-%m-%d')
            except ValueError:
                game_date = raw_date  # keep as-is if format unexpected

            rows.append({
                'player_name': prop_name,
                'nba_id': nba_id,
                'game_date': game_date,
                'matchup': matchup,
                'is_home': is_home,
                'points': pts,
                'rebounds': reb,
                'assists': ast,
                'steals': stl,
                'blocks': blk,
                'fg3m': fg3m,
                'minutes': mins,
                'pra': round(pts + reb + ast, 1),
                'win': wl == 'W',
                'fetched_at': datetime.utcnow().isoformat(),
            })

        all_log_rows.extend(rows)
        print(f"{len(rows)} games")

        # nba_api has built-in rate limiting, but add extra buffer for CI environments
        time.sleep(0.8)

    except Exception as e:
        print(f"ERROR: {e}")
        time.sleep(1)

print(f"\n      Total game log rows: {len(all_log_rows)}")
supabase_upsert('player_game_logs', all_log_rows, on_conflict='player_name,game_date')
print("      Saved to Supabase OK")

# ── Step 4: Fetch team defensive rankings ─────────────────────────────────────
print("\n[4/4] Fetching team defensive rankings (season + L15 + pace)...")

# The Opponent/Base dataframes expose TEAM_ID + native OPP_*_RANK columns but
# NOT TEAM_ABBREVIATION, so we map TEAM_ID -> abbr and read NBA's own ranks
# (1 = fewest allowed = toughest defense), matching fetch_defense_dvp.py.
from nba_api.stats.static import teams as nba_teams_static
TEAM_ID_TO_ABBR = {t['id']: t['abbreviation'] for t in nba_teams_static.get_teams()}

# rank_col -> native NBA rank column
RANK_COL_MAP = {
    'pts_rank':  'OPP_PTS_RANK',
    'reb_rank':  'OPP_REB_RANK',
    'ast_rank':  'OPP_AST_RANK',
    'blk_rank':  'OPP_BLK_RANK',
    'stl_rank':  'OPP_STL_RANK',
    'fg3m_rank': 'OPP_FG3M_RANK',
}

def fetch_opponent_stats(last_n_games=0):
    """Fetch LeagueDashTeamStats in Opponent mode. last_n_games=0 means full season."""
    kwargs = dict(
        season=SEASON,
        season_type_all_star='Regular Season',
        measure_type_detailed_defense='Opponent',
        per_mode_detailed='PerGame',
        timeout=20,
    )
    if last_n_games > 0:
        kwargs['last_n_games'] = last_n_games
    try:
        return leaguedashteamstats.LeagueDashTeamStats(**kwargs).get_data_frames()[0]
    except TypeError:
        # nba_api version skew on the per_mode kwarg name — retry without it
        kwargs.pop('per_mode_detailed', None)
        kwargs.pop('per_mode_simple', None)
        return leaguedashteamstats.LeagueDashTeamStats(**kwargs).get_data_frames()[0]

def _abbr_of(row):
    return TEAM_ID_TO_ABBR.get(int(row['TEAM_ID'])) if row.get('TEAM_ID') is not None else None

try:
    # 4a. Season-long defense ranks (use NBA's native OPP_*_RANK columns)
    df_season = fetch_opponent_stats(last_n_games=0)
    team_rows = []
    for _, row in df_season.iterrows():
        abbr = _abbr_of(row)
        if not abbr:
            continue
        entry = {'team_abbreviation': abbr, 'fetched_at': datetime.utcnow().isoformat()}
        for rank_col, nba_col in RANK_COL_MAP.items():
            val = row.get(nba_col)
            entry[rank_col] = int(val) if val is not None else 15
        team_rows.append(entry)
    print(f"      Season ranks read for {len(team_rows)} teams")

    # 4b. L15 defense ranks (last 15 games — more responsive to recent form)
    time.sleep(1)
    df_l15 = fetch_opponent_stats(last_n_games=15)
    l15_by_abbr = {}
    for _, row in df_l15.iterrows():
        abbr = _abbr_of(row)
        if not abbr:
            continue
        l15_by_abbr[abbr] = {
            f"{rank_col}_l15": (int(row[nba_col]) if row.get(nba_col) is not None else 15)
            for rank_col, nba_col in RANK_COL_MAP.items()
        }
    for row in team_rows:
        l15 = l15_by_abbr.get(row['team_abbreviation'], {})
        for rank_col in RANK_COL_MAP:
            l15_key = f"{rank_col}_l15"
            row[l15_key] = l15.get(l15_key, row.get(rank_col, 15))
    print(f"      L15 ranks merged ({len(l15_by_abbr)} teams)")

    # 4c. Team pace (possessions per 48 min) from Base stats, keyed by TEAM_ID
    time.sleep(1)
    try:
        # PACE is only exposed by the Advanced measure type (not Base).
        pace_df = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            season_type_all_star='Regular Season',
            measure_type_detailed_defense='Advanced',
            per_mode_detailed='PerGame',
            timeout=20,
        ).get_data_frames()[0]
        pace_by_abbr = {}
        for _, r in pace_df.iterrows():
            abbr = _abbr_of(r)
            if abbr:
                pace_by_abbr[abbr] = float(r.get('PACE', 0) or 0)
        merged = 0
        for row in team_rows:
            p = pace_by_abbr.get(row['team_abbreviation'])
            row['pace'] = p
            if p is not None:
                merged += 1
        print(f"      Pace data merged ({merged} teams)")
    except Exception as e:
        print(f"      WARN: pace fetch failed: {e}")

    supabase_upsert('team_defense_stats', team_rows, on_conflict='team_abbreviation')
    print(f"      Saved {len(team_rows)} team rows to team_defense_stats")

except Exception as e:
    print(f"      ERROR fetching team stats: {e}")

# ── Step 5: Fetch Defense vs Position (DVP) ────────────────────────────────────
print("\n[5/5] Fetching Defense vs Position (DVP)...")
DVP_POSITIONS = [('guard', 'G'), ('forward', 'F'), ('center', 'C')]

try:
    dvp_rows = []
    for position_label, position_abbr in DVP_POSITIONS:
        time.sleep(1)
        try:
            dvp_df = leaguedashteamstats.LeagueDashTeamStats(
                season=SEASON,
                measure_type_detailed_defense='Opponent',
                per_mode_detailed='PerGame',
                player_position_abbreviation_nullable=position_abbr,
                timeout=20,
            ).get_data_frames()[0]
        except Exception as e:
            print(f"      WARN: DVP {position_label} fetch failed: {e}")
            continue

        pos_rows = []
        for _, row in dvp_df.iterrows():
            abbr = _abbr_of(row)
            if not abbr:
                continue
            entry = {
                'team_abbreviation': abbr,
                'position_group': position_label,
                'fetched_at': datetime.utcnow().isoformat(),
            }
            for rank_col, nba_col in RANK_COL_MAP.items():
                val = row.get(nba_col)
                entry[rank_col] = int(val) if val is not None else 15
            pos_rows.append(entry)

        dvp_rows.extend(pos_rows)
        print(f"      {position_label.capitalize()} DVP: {len(pos_rows)} teams")

    dvp_rows = [r for r in dvp_rows if r.get('team_abbreviation')]
    if dvp_rows:
        supabase_upsert('team_defense_vs_position', dvp_rows,
                        on_conflict='team_abbreviation,position_group')
        print(f"      Saved {len(dvp_rows)} DVP rows")

except Exception as e:
    print(f"      ERROR fetching DVP: {e}")

print("\nDone! Run py scripts/daily_refresh.py or hit /api/enrich?force=true to rescore with fresh stats.")
