"""
Fetch real NBA player positions via nba_api and upsert to player_positions table.
Positions barely change during a season — run once at season start or as needed.

Usage:
  py -3.13 scripts/fetch_player_positions.py
  py -3.13 scripts/fetch_player_positions.py --dry-run
"""

import os, sys, argparse, requests, time

try:
    from nba_api.stats.endpoints import playerindex
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

CURRENT_SEASON = '2025-26'

def map_position(raw):
    """Map raw NBA position string to guard/forward/center."""
    p = (raw or '').strip().upper()
    if p in ('C', 'C-F'):
        return 'center'
    if p in ('G', 'G-F', 'F-G'):
        return 'guard'
    return 'forward'  # F, F-C, unknown

def fetch_player_positions():
    print(f'Fetching player index via nba_api (season {CURRENT_SEASON})...')
    pi = playerindex.PlayerIndex(
        season=CURRENT_SEASON,
        timeout=30,
    )
    df = pi.get_data_frames()[0]
    print(f'  Got {len(df)} rows')

    # Only active roster players (ROSTER_STATUS == 1)
    active = df[df['ROSTER_STATUS'] == 1.0].copy()
    print(f'  Active roster: {len(active)} players')

    players = []
    for _, row in active.iterrows():
        first = str(row.get('PLAYER_FIRST_NAME', '')).strip()
        last  = str(row.get('PLAYER_LAST_NAME', '')).strip()
        name  = f'{first} {last}'.strip()
        pos_raw = str(row.get('POSITION', '')).strip()
        if name and pos_raw and pos_raw != 'nan':
            players.append({
                'player_name':    name,
                'nba_position':   pos_raw,
                'position_group': map_position(pos_raw),
            })
    return players

def upsert_positions(players):
    url = f'{SUPABASE_URL}/rest/v1/player_positions'
    upserted = 0
    for i in range(0, len(players), 500):
        chunk = players[i:i+500]
        r = requests.post(url, headers=SB_HEADERS, json=chunk, timeout=30)
        if r.ok:
            upserted += len(chunk)
        else:
            print(f'  [supabase] error: {r.status_code} {r.text[:200]}')
    return upserted

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    print(f'\nFetch Player Positions')
    print(f'{"="*50}')

    players = fetch_player_positions()
    print(f'Found {len(players)} players')

    # Show position distribution
    from collections import Counter
    dist = Counter(p['position_group'] for p in players)
    print(f'Distribution: guards={dist["guard"]}, forwards={dist["forward"]}, centers={dist["center"]}')

    # Show sample
    print(f'\nSample (first 10):')
    for p in players[:10]:
        print(f'  {p["player_name"]:<25} {p["nba_position"]:<6} -> {p["position_group"]}')

    if args.dry_run:
        print('\n[DRY RUN] No upsert made.')
        return

    print(f'\nUpserting {len(players)} players to Supabase...')
    upserted = upsert_positions(players)
    print(f'Done. {upserted} player positions saved.')

if __name__ == '__main__':
    main()
