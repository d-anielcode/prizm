"""
Historical Odds API Backfill
============================
Calls /api/prophistory/backfill in batches to pull real prop lines
from The Odds API into historical_prop_lines.

Estimates credit cost before starting and asks for confirmation.

Usage:
  py -3.13 scripts/backfill_historical.py --start 2025-11-01 --end 2026-02-03
  py -3.13 scripts/backfill_historical.py --start 2025-11-01 --end 2026-02-03 --dry-run
"""

import os, sys, time, argparse, requests
from datetime import datetime, timedelta

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
VERCEL_URL   = (os.environ.get('VERCEL_APP_URL') or env.get('VERCEL_APP_URL') or env.get('NEXT_PUBLIC_SITE_URL', '')).strip('"').strip("'")
CRON_SECRET  = (os.environ.get('CRON_SECRET') or env.get('CRON_SECRET', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY")
    sys.exit(1)
if not VERCEL_URL or not CRON_SECRET:
    print("ERROR: Missing VERCEL_APP_URL or CRON_SECRET in .env.local")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
}

CRON_HEADERS = {
    'Authorization': f'Bearer {CRON_SECRET}',
}

def get_existing_dates():
    """Return set of dates already in historical_prop_lines."""
    r = requests.get(
        f'{SUPABASE_URL}/rest/v1/historical_prop_lines?select=game_date&limit=5000',
        headers=SB_HEADERS, timeout=15
    )
    if not r.ok:
        print(f"WARNING: Could not fetch existing dates: {r.status_code}")
        return set()
    return set(row['game_date'] for row in r.json() if row.get('game_date'))

def date_range(start, end):
    """Generate list of YYYY-MM-DD strings from start to end inclusive."""
    dates = []
    d = datetime.strptime(start, '%Y-%m-%d')
    e = datetime.strptime(end,   '%Y-%m-%d')
    while d <= e:
        dates.append(d.strftime('%Y-%m-%d'))
        d += timedelta(days=1)
    return dates

def estimate_credits(n_dates, avg_events_per_day=10):
    """Estimate Odds API credit usage. Cost: 1 req for events + 70 per event."""
    return n_dates * (1 + avg_events_per_day * 70)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', required=True, help='Start date YYYY-MM-DD')
    parser.add_argument('--end',   required=True, help='End date YYYY-MM-DD')
    parser.add_argument('--days-per-batch', type=int, default=2,
                        help='Dates per API call (default 2, max 7)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Show plan without making API calls')
    parser.add_argument('--skip-existing', action='store_true', default=True,
                        help='Skip dates already in historical_prop_lines (default True)')
    args = parser.parse_args()

    all_dates = date_range(args.start, args.end)
    print(f"\nHistorical Backfill Plan")
    print(f"{'='*50}")
    print(f"Range:      {args.start} to {args.end} ({len(all_dates)} calendar days)")

    # Check which dates already exist
    if args.skip_existing:
        print("Checking existing dates in Supabase...", end=' ', flush=True)
        existing = get_existing_dates()
        print(f"{len(existing)} dates already loaded")
        missing = [d for d in all_dates if d not in existing]
    else:
        missing = all_dates

    print(f"Dates to fetch: {len(missing)}")
    if not missing:
        print("Nothing to do — all dates already loaded.")
        return

    # Estimate credit cost
    est_credits = estimate_credits(len(missing))
    est_days_at_10 = len(missing)
    print(f"\nCredit estimate: ~{est_credits:,} requests")
    print(f"  ({len(missing)} days x ~10 games x 70 req/game + {len(missing)} event-list calls)")
    print(f"  Note: real cost depends on how many games per day")
    print(f"\nDates to process:")
    for d in missing[:10]:
        print(f"  {d}")
    if len(missing) > 10:
        print(f"  ... and {len(missing)-10} more")

    if args.dry_run:
        print("\n[DRY RUN] No API calls made.")
        return

    print(f"\nProceed? (y/n): ", end='')
    confirm = input().strip().lower()
    if confirm != 'y':
        print("Aborted.")
        return

    # Process in batches
    batch_size = min(args.days_per_batch, 7)
    total_upserted = 0
    failed_dates = []

    i = 0
    while i < len(missing):
        batch = missing[i:i+batch_size]
        start_d = batch[0]
        end_d   = batch[-1]

        print(f"\n[{i+1}/{len(missing)}] Fetching {start_d} to {end_d}...", end=' ', flush=True)

        url = f"{VERCEL_URL}/api/prophistory/backfill?start={start_d}&end={end_d}&limit={batch_size}"
        try:
            r = requests.get(url, headers=CRON_HEADERS, timeout=120)
            if r.ok:
                data = r.json()
                upserted = data.get('totalUpserted', 0)
                total_upserted += upserted
                dates_done = data.get('datesProcessed', [])
                print(f"OK — {upserted} rows upserted ({', '.join(str(d) for d in dates_done[:3])})")
            else:
                print(f"ERROR {r.status_code}: {r.text[:200]}")
                failed_dates.extend(batch)
        except Exception as e:
            print(f"EXCEPTION: {e}")
            failed_dates.extend(batch)

        i += batch_size
        if i < len(missing):
            time.sleep(2)  # brief pause between batches

    print(f"\n{'='*50}")
    print(f"Done. {total_upserted} total rows upserted across {len(missing)-len(failed_dates)} dates.")
    if failed_dates:
        print(f"Failed dates ({len(failed_dates)}): {failed_dates}")
    print(f"\nNext steps:")
    print(f"  1. Run /api/prophistory/enrich to score the new lines")
    print(f"  2. Run /api/grade for each new date to grade against game logs")
    print(f"  3. Re-run: py -3.13 scripts/backtest_pit.py --mode real --days 120")

if __name__ == '__main__':
    main()
