"""
Fetch NBA team defense vs position (DVP) stats from stats.nba.com and upsert to
team_defense_vs_position table. Uses nba_api which handles stats.nba.com properly.

Usage:
  py -3.13 scripts/fetch_defense_dvp.py
  py -3.13 scripts/fetch_defense_dvp.py --dry-run
"""

import os, sys, argparse, time, requests

try:
    from nba_api.stats.endpoints import leaguedashteamstats
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

CURRENT_SEASON = '2025-26'

# nba_api already provides _RANK columns; map them directly.
# Rank direction from NBA.com: 1 = best defense (fewest allowed), 30 = worst.
RANK_COL_MAP = {
    'pts_rank':  'OPP_PTS_RANK',
    'reb_rank':  'OPP_REB_RANK',
    'ast_rank':  'OPP_AST_RANK',
    'blk_rank':  'OPP_BLK_RANK',
    'stl_rank':  'OPP_STL_RANK',
    'fg3m_rank': 'OPP_FG3M_RANK',
}

# Build team_id → abbreviation lookup
_TEAM_LIST = nba_teams.get_teams()
TEAM_ID_TO_ABBR = {t['id']: t['abbreviation'] for t in _TEAM_LIST}

def fetch_dvp_for_position(position_abbr, position_label):
    """Fetch opponent stats filtered by opposing player position."""
    print(f'  Fetching DVP for {position_label} (PlayerPosition={position_abbr})...')
    stats = leaguedashteamstats.LeagueDashTeamStats(
        season=CURRENT_SEASON,
        season_type_all_star='Regular Season',
        measure_type_detailed_defense='Opponent',
        per_mode_detailed='PerGame',
        player_position_abbreviation_nullable=position_abbr,
        timeout=30,
    )
    df = stats.get_data_frames()[0]

    rows = []
    for _, row in df.iterrows():
        team_id = int(row['TEAM_ID'])
        abbr = TEAM_ID_TO_ABBR.get(team_id)
        if not abbr:
            continue
        r = {'team_abbreviation': abbr, 'position_group': position_label}
        for rank_col, nba_col in RANK_COL_MAP.items():
            r[rank_col] = int(row.get(nba_col, 15) or 15)
        rows.append(r)

    print(f'    -> {len(rows)} teams')
    return rows

def upsert_dvp(rows):
    url = f'{SUPABASE_URL}/rest/v1/team_defense_vs_position'
    upserted = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i+500]
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

    print(f'\nFetch Defense vs Position (DVP)')
    print(f'{"="*50}')
    print(f'Season: {CURRENT_SEASON}')

    positions = [
        ('G', 'guard'),
        ('F', 'forward'),
        ('C', 'center'),
    ]

    all_rows = []
    for abbr, label in positions:
        rows = fetch_dvp_for_position(abbr, label)
        all_rows.extend(rows)
        time.sleep(0.5)  # brief pause between calls

    print(f'\nTotal: {len(all_rows)} DVP rows ({len(positions)} positions x 30 teams)')

    if args.dry_run:
        # Show sample
        sample = [r for r in all_rows if r['position_group'] == 'guard'][:5]
        print('\nSample (guard DVP):')
        for r in sample:
            print(f'  {r["team_abbreviation"]:<5} pts_rank={r["pts_rank"]} reb_rank={r["reb_rank"]} ast_rank={r["ast_rank"]} fg3m_rank={r["fg3m_rank"]}')
        print('\n[DRY RUN] No upsert made.')
        return

    print(f'\nUpserting {len(all_rows)} rows to Supabase...')
    upserted = upsert_dvp(all_rows)
    print(f'Done. {upserted} DVP rows saved.')

if __name__ == '__main__':
    main()
