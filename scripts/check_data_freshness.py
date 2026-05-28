"""
Fail loudly if the NBA defensive-data tables have gone stale.

Run at the end of the daily-stats GitHub Actions job. For weeks the defense
fetch silently 504'd/failed while the job stayed green (continue-on-error +
curl -sf | head swallowed every error), so team_defense_stats froze for ~2
months without anyone noticing. This guard turns that into a hard CI failure.

Checks team_defense_stats:
  - newest fetched_at is within MAX_AGE_HOURS
  - at least MIN_PACE_TEAMS rows have a non-zero pace (pace lives only in the
    Advanced measure type; a regression there silently writes 0.00 / null)

Exit 0 = fresh, exit 1 = stale (fails the workflow).
"""

import os
import sys
from datetime import datetime, timezone

import requests

MAX_AGE_HOURS = 48
MIN_PACE_TEAMS = 25  # of 30

# Load creds from env (CI) or .env.local (local runs)
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
    print('ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY')
    sys.exit(1)

HEADERS = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}


def fail(msg):
    print(f'STALE: {msg}')
    sys.exit(1)


def main():
    url = (f'{SUPABASE_URL}/rest/v1/team_defense_stats'
           '?select=team_abbreviation,fetched_at,pace')
    r = requests.get(url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    rows = r.json()

    if not rows:
        fail('team_defense_stats is empty')

    # Newest fetched_at
    newest = max(row['fetched_at'] for row in rows if row.get('fetched_at'))
    newest_dt = datetime.fromisoformat(newest.replace('Z', '+00:00'))
    age_hours = (datetime.now(timezone.utc) - newest_dt).total_seconds() / 3600
    if age_hours > MAX_AGE_HOURS:
        fail(f'newest team_defense_stats row is {age_hours:.1f}h old '
             f'(max {MAX_AGE_HOURS}h). Defense fetch is not running.')

    # Pace coverage (pace lives only in Advanced measure type)
    pace_ok = sum(1 for row in rows if row.get('pace'))
    if pace_ok < MIN_PACE_TEAMS:
        fail(f'only {pace_ok}/{len(rows)} teams have non-zero pace '
             f'(need {MIN_PACE_TEAMS}). Pace fetch is broken.')

    print(f'OK: {len(rows)} teams, newest {age_hours:.1f}h old, '
          f'{pace_ok} with pace.')
    sys.exit(0)


if __name__ == '__main__':
    main()
