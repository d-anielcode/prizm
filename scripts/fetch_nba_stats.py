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

def supabase_upsert(table, rows):
    if not rows:
        return
    url = f'{SUPABASE_URL}/rest/v1/{table}'
    # Batch in chunks of 200
    for i in range(0, len(rows), 200):
        chunk = rows[i:i+200]
        r = requests.post(url, headers=HEADERS, json=chunk, timeout=30)
        if not r.ok:
            print(f'  [supabase] upsert error on {table}: {r.status_code} {r.text[:200]}')

# ── NBA API imports ───────────────────────────────────────────────────────────
import argparse
from datetime import date, timedelta

# stats.nba.com blocks requests from cloud IPs without browser-like headers
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

if use_history_mode:
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
supabase_upsert('player_game_logs', all_log_rows)
print("      Saved to Supabase OK")

# ── Step 4: Fetch team defensive rankings ─────────────────────────────────────
print("\n[4/4] Fetching team defensive rankings (season + L15 + pace)...")

STAT_COLS = {
    'pts_rank':  'OPP_PTS',
    'reb_rank':  'OPP_REB',
    'ast_rank':  'OPP_AST',
    'blk_rank':  'OPP_BLK',
    'stl_rank':  'OPP_STL',
    'fg3m_rank': 'OPP_FG3M',
}

def fetch_opponent_stats(last_n_games=0):
    """Fetch LeagueDashTeamStats in Opponent mode. last_n_games=0 means full season."""
    kwargs = dict(
        season=SEASON,
        measure_type_detailed_defense='Opponent',
        per_mode_simple='PerGame',
        timeout=20,
    )
    if last_n_games > 0:
        kwargs['last_n_games'] = last_n_games
    try:
        return leaguedashteamstats.LeagueDashTeamStats(**kwargs).get_data_frames()[0]
    except TypeError:
        # Older nba_api versions don't have per_mode_simple
        kwargs.pop('per_mode_simple', None)
        return leaguedashteamstats.LeagueDashTeamStats(**kwargs).get_data_frames()[0]

def compute_ranks(rows, stat_cols):
    """Mutate rows to add rank columns (1=fewest allowed=toughest D)."""
    for rank_col, raw_col in stat_cols.items():
        vals = sorted(
            [(r['team_abbreviation'], r.pop(raw_col, 0) or 0) for r in rows],
            key=lambda x: x[1]
        )
        rank_map = {abbr: rank + 1 for rank, (abbr, _) in enumerate(vals)}
        for row in rows:
            row[rank_col] = rank_map.get(row['team_abbreviation'], 15)

try:
    # 4a. Season-long defense ranks
    df_season = fetch_opponent_stats(last_n_games=0)
    team_rows = []
    for _, row in df_season.iterrows():
        abbr = str(row.get('TEAM_ABBREVIATION', ''))
        entry = {'team_abbreviation': abbr, 'fetched_at': datetime.utcnow().isoformat()}
        for rank_col, raw_col in STAT_COLS.items():
            val = row.get(raw_col)
            entry[raw_col] = float(val) if val is not None else None
        team_rows.append(entry)
    compute_ranks(team_rows, STAT_COLS)
    print(f"      Season ranks computed for {len(team_rows)} teams")

    # 4b. L15 defense ranks (last 15 games — more responsive to recent form)
    time.sleep(1)
    df_l15 = fetch_opponent_stats(last_n_games=15)
    l15_rows = []
    L15_COLS = {k.replace('_rank', '_rank_l15'): v for k, v in STAT_COLS.items()}
    for _, row in df_l15.iterrows():
        abbr = str(row.get('TEAM_ABBREVIATION', ''))
        entry = {'team_abbreviation': abbr}
        for rank_col, raw_col in L15_COLS.items():
            val = row.get(raw_col)
            entry[raw_col] = float(val) if val is not None else None
        l15_rows.append(entry)
    compute_ranks(l15_rows, L15_COLS)
    # Merge L15 ranks into team_rows
    l15_by_abbr = {r['team_abbreviation']: r for r in l15_rows}
    for row in team_rows:
        l15 = l15_by_abbr.get(row['team_abbreviation'], {})
        for col in L15_COLS:
            row[col] = l15.get(col, row.get(col.replace('_l15', ''), 15))
    print(f"      L15 ranks merged")

    # 4c. Team pace (possessions per 48 min) from Base stats
    time.sleep(1)
    try:
        pace_df = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            measure_type_detailed_defense='Base',
            per_mode_simple='PerGame',
            timeout=20,
        ).get_data_frames()[0]
        pace_by_abbr = {str(r.get('TEAM_ABBREVIATION', '')): float(r.get('PACE', 0) or 0)
                        for _, r in pace_df.iterrows()}
        for row in team_rows:
            row['pace'] = pace_by_abbr.get(row['team_abbreviation'], None)
        print(f"      Pace data merged")
    except Exception as e:
        print(f"      WARN: pace fetch failed: {e}")

    supabase_upsert('team_defense_stats', team_rows)
    print(f"      Saved {len(team_rows)} team rows to team_defense_stats ✓")

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
                per_mode_simple='PerGame',
                player_position_abbreviation_nullable=position_abbr,
                timeout=20,
            ).get_data_frames()[0]
        except Exception as e:
            print(f"      WARN: DVP {position_label} fetch failed: {e}")
            continue

        pos_rows = []
        for _, row in dvp_df.iterrows():
            abbr = str(row.get('TEAM_ABBREVIATION', ''))
            entry = {
                'team_abbreviation': abbr,
                'position_group': position_label,
                'fetched_at': datetime.utcnow().isoformat(),
            }
            for rank_col, raw_col in STAT_COLS.items():
                val = row.get(raw_col)
                entry[raw_col] = float(val) if val is not None else None
            pos_rows.append(entry)

        # Compute ranks within position (1=fewest allowed to this position type)
        compute_ranks(pos_rows, STAT_COLS)
        dvp_rows.extend(pos_rows)
        print(f"      {position_label.capitalize()} DVP: {len(pos_rows)} teams")

    if dvp_rows:
        supabase_upsert('team_defense_vs_position', dvp_rows)
        print(f"      Saved {len(dvp_rows)} DVP rows ✓")

except Exception as e:
    print(f"      ERROR fetching DVP: {e}")

print("\nDone! Run py scripts/daily_refresh.py or hit /api/enrich?force=true to rescore with fresh stats.")
