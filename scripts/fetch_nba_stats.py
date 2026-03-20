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

parser = argparse.ArgumentParser()
parser.add_argument('--yesterday', action='store_true',
                    help='Fetch stats for players who played last night (use in morning after overnight games)')
parser.add_argument('--today', action='store_true',
                    help='Fetch stats for players who played today (use at night after games finish ~11pm ET)')
parser.add_argument('--date', type=str, default=None,
                    help='Specific date to pull box scores from (YYYY-MM-DD)')
args = parser.parse_args()

from nba_api.stats.static import players as nba_players_static
from nba_api.stats.endpoints import playergamelog, leaguedashteamstats, leaguegamelog

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
            timeout=30,
        )
        df_lg = lg.get_data_frames()[0]
        if not df_lg.empty:
            player_names_set.update(df_lg['PLAYER_NAME'].dropna().unique().tolist())
            print(f"      Found {len(player_names_set)} players who played on {target_date}")
        else:
            print(f"      No games found for {target_date} (games may not be final yet)")
    except Exception as e:
        print(f"      ERROR fetching LeagueGameLog: {e}")

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
SEASON      = '2025-26'
PREV_SEASON = '2024-25'

for i, (prop_name, player) in enumerate(resolved.items()):
    nba_id = player['id']
    print(f"  [{i+1}/{len(resolved)}] {prop_name} (id={nba_id})", end=' ... ', flush=True)
    try:
        # Fetch current season
        log_curr = playergamelog.PlayerGameLog(
            player_id=nba_id,
            season=SEASON,
            season_type_all_star='Regular Season',
            timeout=10,
        )
        df_curr = log_curr.get_data_frames()[0]
        time.sleep(0.2)

        # Fetch prior season to fill up to 60 games total for better vs-opponent history
        log_prev = playergamelog.PlayerGameLog(
            player_id=nba_id,
            season=PREV_SEASON,
            season_type_all_star='Regular Season',
            timeout=10,
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

        # nba_api has built-in rate limiting, but add extra buffer
        time.sleep(0.3)

    except Exception as e:
        print(f"ERROR: {e}")
        time.sleep(1)

print(f"\n      Total game log rows: {len(all_log_rows)}")
supabase_upsert('player_game_logs', all_log_rows)
print("      Saved to Supabase OK")

# ── Step 4: Fetch team defensive rankings ────────────────────────────────────
print("\n[4/4] Fetching team defensive rankings...")
try:
    # nba_api renamed per_mode_simple in newer versions — try both
    try:
        def_stats = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            measure_type_detailed_defense='Opponent',
            per_mode_simple='PerGame',
            timeout=15,
        )
    except TypeError:
        def_stats = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            measure_type_detailed_defense='Opponent',
            timeout=15,
        )
    df = def_stats.get_data_frames()[0]

    # Rank teams by how many of each stat they allow (ascending = tightest defense)
    stat_cols = {
        'pts_rank': 'OPP_PTS',
        'reb_rank': 'OPP_REB',
        'ast_rank': 'OPP_AST',
        'blk_rank': 'OPP_BLK',
        'stl_rank': 'OPP_STL',
        'fg3m_rank': 'OPP_FG3M',
    }

    team_rows = []
    for _, row in df.iterrows():
        team_abbr = str(row.get('TEAM_ABBREVIATION', ''))
        entry = {
            'team_abbreviation': team_abbr,
            'fetched_at': datetime.utcnow().isoformat(),
        }
        # We'll rank after building all rows
        for rank_col, raw_col in stat_cols.items():
            val = row.get(raw_col)
            entry[raw_col] = float(val) if val is not None else None
        team_rows.append(entry)

    # Compute ranks (1 = allows fewest = toughest defense)
    for rank_col, raw_col in stat_cols.items():
        vals = sorted(
            [(r['team_abbreviation'], r.get(raw_col, 0) or 0) for r in team_rows],
            key=lambda x: x[1]
        )
        rank_map = {abbr: rank+1 for rank, (abbr, _) in enumerate(vals)}
        for row in team_rows:
            row[rank_col] = rank_map.get(row['team_abbreviation'], 15)

    # Clean up raw cols before upserting
    for row in team_rows:
        for raw_col in stat_cols.values():
            row.pop(raw_col, None)

    supabase_upsert('team_defense_stats', team_rows)
    print(f"      Saved rankings for {len(team_rows)} teams ✓")

except Exception as e:
    print(f"      ERROR fetching team stats: {e}")

print("\nDone! Run py scripts/daily_refresh.py or hit /api/enrich?force=true to rescore with fresh stats.")
