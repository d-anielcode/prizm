"""
Direct Historical Backfill — bypasses Vercel, calls The Odds API + Supabase directly.

Usage:
  py -3.13 scripts/backfill_direct.py --start 2025-12-01 --end 2026-02-03
  py -3.13 scripts/backfill_direct.py --start 2025-12-01 --end 2026-02-03 --dry-run
"""

import os, sys, time, argparse, requests, urllib.parse, json
from datetime import datetime, timedelta
from collections import defaultdict

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
ODDS_API_KEY = (os.environ.get('ODDS_API_KEY') or env.get('ODDS_API_KEY', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY")
    sys.exit(1)
if not ODDS_API_KEY:
    print("ERROR: Missing ODDS_API_KEY in .env.local")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
}

MARKETS = 'player_points,player_rebounds,player_assists,player_threes,player_steals,player_blocks,player_points_rebounds_assists'
MARKET_TO_STAT = {
    'player_points':                   'points',
    'player_rebounds':                 'rebounds',
    'player_assists':                  'assists',
    'player_threes':                   'three_pointers',
    'player_steals':                   'steals',
    'player_blocks':                   'blocks',
    'player_points_rebounds_assists':  'pra',
}
BOOKMAKERS = 'draftkings,fanduel'

def to_eastern_date(iso):
    from datetime import timezone
    import time as _time
    # Simple ET conversion: UTC-5 (EST) or UTC-4 (EDT)
    dt = datetime.strptime(iso[:19], '%Y-%m-%dT%H:%M:%S')
    # Approximate: use UTC-5 for Nov-Mar, UTC-4 for Mar-Nov
    month = dt.month
    offset = 4 if 3 < month < 11 else 5
    et = dt - timedelta(hours=offset)
    return et.strftime('%Y-%m-%d')

def fetch_events(snapshot_date):
    url = (f'https://api.the-odds-api.com/v4/historical/sports/basketball_nba/events'
           f'?apiKey={ODDS_API_KEY}&date={urllib.parse.quote(snapshot_date)}')
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    remaining = r.headers.get('x-requests-remaining', '?')
    data = r.json().get('data', [])
    return data, remaining

def fetch_event_props(event_id, snapshot_date):
    url = (f'https://api.the-odds-api.com/v4/historical/sports/basketball_nba/events/{event_id}/odds'
           f'?apiKey={ODDS_API_KEY}&date={urllib.parse.quote(snapshot_date)}'
           f'&markets={MARKETS}&regions=us&oddsFormat=american&bookmakers={BOOKMAKERS}')
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    remaining = r.headers.get('x-requests-remaining', '?')
    event_data = r.json().get('data') or {}
    return event_data, remaining

def parse_props(event_data, game_date, home_team, away_team, commence_time):
    lines = []
    for book in event_data.get('bookmakers', []):
        for market in book.get('markets', []):
            stat_type = MARKET_TO_STAT.get(market['key'])
            if not stat_type:
                continue
            player_map = {}
            for outcome in market.get('outcomes', []):
                player = outcome.get('description', '').strip()
                if not player or outcome.get('point') is None:
                    continue
                if player not in player_map:
                    player_map[player] = {}
                name = outcome.get('name', '')
                if name == 'Over':
                    player_map[player]['over'] = outcome['point']
                    player_map[player]['over_odds'] = outcome.get('price')
                elif name == 'Under':
                    player_map[player]['under'] = outcome['point']
                    player_map[player]['under_odds'] = outcome.get('price')

            for player, pl in player_map.items():
                line = pl.get('over') or pl.get('under')
                if line is None:
                    continue
                for direction in ('over', 'under'):
                    if pl.get(direction) is None:
                        continue
                    lines.append({
                        'game_date':     game_date,
                        'game_id':       event_data.get('id', ''),
                        'player_name':   player,
                        'stat_type':     stat_type,
                        'direction':     direction,
                        'line':          pl[direction],
                        'odds':          pl.get(f'{direction}_odds'),
                        'sportsbook':    book['key'],
                        'home_team':     home_team,
                        'away_team':     away_team,
                        'commence_time': commence_time,
                    })
    return lines

def supabase_upsert(rows):
    if not rows:
        return 0
    url = f'{SUPABASE_URL}/rest/v1/historical_prop_lines'
    upserted = 0
    for i in range(0, len(rows), 500):
        chunk = rows[i:i+500]
        r = requests.post(url, headers=SB_HEADERS, json=chunk, timeout=30)
        if r.ok:
            upserted += len(chunk)
        else:
            print(f'  [supabase] upsert error: {r.status_code} {r.text[:200]}')
    return upserted

def get_existing_dates():
    r = requests.get(
        f'{SUPABASE_URL}/rest/v1/historical_prop_lines?select=game_date&limit=5000',
        headers={'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'},
        timeout=15
    )
    if not r.ok:
        return set()
    return set(row['game_date'] for row in r.json() if row.get('game_date'))

def date_range(start, end):
    dates = []
    d = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.strptime(end, '%Y-%m-%d')
    while d <= e:
        dates.append(d.strftime('%Y-%m-%d'))
        d += timedelta(days=1)
    return dates

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', required=True)
    parser.add_argument('--end',   required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    all_dates = date_range(args.start, args.end)

    print(f"\nDirect Historical Backfill")
    print(f"{'='*50}")
    print(f"Range: {args.start} to {args.end} ({len(all_dates)} calendar days)")
    print(f"Checking existing dates...", end=' ', flush=True)
    existing = get_existing_dates()
    print(f"{len(existing)} already loaded")

    missing = [d for d in all_dates if d not in existing]
    print(f"Dates to fetch: {len(missing)}")

    if not missing:
        print("Nothing to do.")
        return

    est = len(missing) * (1 + 10 * 70)
    print(f"Credit estimate: ~{est:,} (based on ~10 games/day)")

    if args.dry_run:
        print(f"\nDates that would be fetched:")
        for d in missing:
            print(f"  {d}")
        print("\n[DRY RUN] No API calls made.")
        return

    print(f"\nProceed? (y/n): ", end='')
    if input().strip().lower() != 'y':
        print("Aborted.")
        return

    total_upserted = 0
    total_credits_used = 0
    remaining = '?'

    for i, game_date in enumerate(missing):
        snapshot = f'{game_date}T23:00:00Z'
        print(f"\n[{i+1}/{len(missing)}] {game_date}", end=' ', flush=True)

        try:
            events, remaining = fetch_events(snapshot)
            if not events:
                print(f"-> 0 events (no NBA games)")
                continue

            print(f"-> {len(events)} games", end=' ', flush=True)
            all_lines = []

            for ev in events:
                ev_date = to_eastern_date(ev['commence_time'])
                try:
                    event_data, remaining = fetch_event_props(ev['id'], snapshot)
                    lines = parse_props(
                        event_data,
                        ev_date,
                        ev['home_team'],
                        ev['away_team'],
                        ev['commence_time'],
                    )
                    all_lines.extend(lines)
                    time.sleep(0.3)
                except Exception as e:
                    print(f"\n  WARNING: props fetch failed for {ev['id']}: {e}")

            upserted = supabase_upsert(all_lines)
            total_upserted += upserted
            print(f"-> {len(all_lines)} lines, {upserted} upserted | credits left: {remaining}")

        except Exception as e:
            print(f"\n  ERROR: {e}")

        time.sleep(0.5)

    print(f"\n{'='*50}")
    print(f"Done. {total_upserted} total rows upserted across {len(missing)} dates.")
    print(f"Credits remaining: {remaining}")
    print(f"\nNext steps:")
    print(f"  1. Call /api/prophistory/enrich?start={args.start}&end={args.end}")
    print(f"  2. Call /api/grade for each new date")
    print(f"  3. py -3.13 scripts/backtest_pit.py --mode real --days 120")

if __name__ == '__main__':
    main()
