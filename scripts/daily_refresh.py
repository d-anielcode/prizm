"""
NBA IQ — Daily Refresh (Local)
===============================
Run this once per day to fully refresh the app with today's (or tomorrow's) props.
It does everything in order:
  1. Fetch NBA game logs + team defense from stats.nba.com
  2. Refresh props from odds-api.io
  3. Run the AI scoring model

Usage (run from your project folder):
    python scripts/daily_refresh.py

Or from anywhere:
    python C:/Users/dcho0/nbaiqproject/scripts/daily_refresh.py
"""

import subprocess, sys, os, time

import urllib.request, urllib.error

BASE_URL = 'http://localhost:3000'

def step(n, label):
    print(f'\n[{n}/3] {label}')
    print('─' * 50)

def call_api(path, label):
    url = f'{BASE_URL}{path}'
    print(f'  Calling {url} ...')
    try:
        with urllib.request.urlopen(url, timeout=300) as r:
            body = r.read().decode()
            print(f'  Response: {body[:200]}')
            return True
    except urllib.error.URLError as e:
        print(f'  ERROR: {e}')
        print(f'  Make sure your dev server is running: npm run dev')
        return False

# ── Step 1: Fetch NBA stats ───────────────────────────────────────────────────
step(1, 'Fetching NBA game logs + team defense stats...')
script = os.path.join(os.path.dirname(__file__), 'fetch_nba_stats.py')
result = subprocess.run([sys.executable, script], capture_output=False)
if result.returncode != 0:
    print('\nERROR: Stats fetch failed. Continuing anyway (AI model will use book odds).')

# ── Step 2: Refresh props ─────────────────────────────────────────────────────
step(2, 'Refreshing props from odds-api.io...')
ok = call_api('/api/props?refresh=true', 'props')
if ok:
    print('  Waiting 3s for props to settle...')
    time.sleep(3)

# ── Step 3: Run AI scoring ────────────────────────────────────────────────────
step(3, 'Running AI confidence scoring model...')
call_api('/api/enrich?force=true', 'enrich')

print('\n' + '=' * 50)
print('Daily refresh complete!')
print(f'View your props at: {BASE_URL}')
print('=' * 50)
