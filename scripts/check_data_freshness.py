"""
Flag (and, in the regular season, fail loudly on) stale NBA defensive data.

Run at the END of the daily-stats GitHub Actions job — after enrichment/grading
— so a stale-defense signal never blocks the user-facing pipeline. For weeks the
defense fetch silently 504'd/failed while the job stayed green (continue-on-error
+ curl -sf | head swallowed every error), so team_defense_stats froze for ~2
months unnoticed. This guard makes that visible.

Checks team_defense_stats:
  - newest fetched_at is within MAX_AGE_HOURS  (AGE)
  - at least MIN_PACE_TEAMS rows have a non-zero pace  (PACE)
  - table is non-empty  (EMPTY)

Season-awareness: team_defense_stats holds REGULAR-SEASON aggregates, which are
final once the regular season ends (~mid-April). During the playoffs/offseason
the age check is therefore expected to grow and is downgraded to a non-fatal
warning. EMPTY/PACE indicate real corruption and fail in any season.

Exit codes: 0 = fresh OR only-stale-but-offseason (warned). 1 = a hard problem
(empty/pace any time, or stale during the regular season).
"""

import os
import sys
from datetime import datetime, timezone

import requests

MAX_AGE_HOURS = 48
MIN_PACE_TEAMS = 25  # of 30


def _in_regular_season(now):
    """NBA regular season runs ~late Oct to ~mid-Apr. Outside that window
    (playoffs + offseason) regular-season defense data is final and will not
    refresh, so an old fetched_at is expected rather than a fault."""
    m, d = now.month, now.day
    if m in (11, 12, 1, 2, 3):
        return True
    if m == 10:
        return d >= 20
    if m == 4:
        return d <= 20
    return False


def warn(msg):
    # GitHub Actions annotation: visible on the run without failing the job.
    print(f'::warning::{msg}')

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

    # EMPTY — real corruption in any season.
    if not rows:
        fail('team_defense_stats is empty')

    now = datetime.now(timezone.utc)

    # PACE coverage (pace lives only in the Advanced measure type) — real
    # corruption in any season; final regular-season data still has pace.
    pace_ok = sum(1 for row in rows if row.get('pace'))
    if pace_ok < MIN_PACE_TEAMS:
        fail(f'only {pace_ok}/{len(rows)} teams have non-zero pace '
             f'(need {MIN_PACE_TEAMS}). Pace fetch is broken.')

    # AGE — fatal only during the regular season; otherwise expected.
    newest = max(row['fetched_at'] for row in rows if row.get('fetched_at'))
    newest_dt = datetime.fromisoformat(newest.replace('Z', '+00:00'))
    age_hours = (now - newest_dt).total_seconds() / 3600
    if age_hours > MAX_AGE_HOURS:
        msg = (f'newest team_defense_stats row is {age_hours:.1f}h old '
               f'(max {MAX_AGE_HOURS}h).')
        if _in_regular_season(now):
            fail(msg + ' Defense fetch is not running.')
        warn(msg + ' Outside the NBA regular season - regular-season defense '
                   'data is final, so this is expected. Not failing.')

    print(f'OK: {len(rows)} teams, newest {age_hours:.1f}h old, '
          f'{pace_ok} with pace.')
    sys.exit(0)


if __name__ == '__main__':
    main()
