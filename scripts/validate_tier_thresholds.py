"""Leak-free validation of calibration-derived tier thresholds.

Fit the isotonic calibration on game_date < cutoff, derive tier thresholds from
that TRAIN fit, then assign tiers on the held-out window (>= cutoff) using the
stored RAW confidence_score and report each tier's actual hit-rate, volume, and
EV at -110. Adopt the targets only if held-out LOCK/PLAY clear their floors.

Usage:
    python3 scripts/validate_tier_thresholds.py --cutoff 2026-04-15
"""
import os, sys, argparse
from collections import defaultdict

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

import requests
import numpy as np
from sklearn.isotonic import IsotonicRegression
from tier_thresholds import derive_tier_thresholds, DEFAULT_TARGETS

SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")
HEADERS = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}
BREAKEVEN = 110 / 210  # -110 juice = 0.5238

def sb_get_all(table, params=''):
    rows, offset = [], 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=HEADERS, timeout=30); r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    return rows

def fit_lookup(scores, hits):
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds='clip')
    iso.fit(scores, hits)
    return (iso.predict(np.arange(0, 101, 1)) * 100).round(2).tolist()

def assign(score, thr):
    if thr['lock'] is not None and score >= thr['lock']: return 'LOCK'
    if thr['play'] is not None and score >= thr['play']: return 'PLAY'
    return 'FADE'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cutoff', default='2026-04-15', help='train < cutoff, test >= cutoff')
    args = ap.parse_args()

    grades = sb_get_all('prop_grades')
    grades = [g for g in grades if g.get('hit') is not None and g.get('confidence_score') is not None]
    train = [g for g in grades if g['game_date'] < args.cutoff]
    test  = [g for g in grades if g['game_date'] >= args.cutoff]
    print(f"train={len(train):,}  test={len(test):,}  cutoff={args.cutoff}")
    if len(train) < 2000 or len(test) < 500:
        print("INSUFFICIENT data for a leak-free split"); sys.exit(1)

    ts = np.array([float(g['confidence_score']) for g in train])
    th = np.array([1 if g['hit'] else 0 for g in train])
    stt = np.array([g.get('stat_type', '') for g in train])

    thr_by_stat = {'_global': derive_tier_thresholds(fit_lookup(ts, th), DEFAULT_TARGETS)}
    for stat in ['points', 'rebounds', 'assists', 'pra', 'steals', 'blocks', 'three_pointers']:
        m = stt == stat
        if int(m.sum()) >= 500:
            thr_by_stat[stat] = derive_tier_thresholds(fit_lookup(ts[m], th[m]), DEFAULT_TARGETS)

    print("\n  Train-derived thresholds:")
    for k, v in thr_by_stat.items():
        print(f"    {k:<14} lock={v['lock']}  play={v['play']}")

    tally = defaultdict(lambda: [0, 0])  # tier -> [hits, n]
    for g in test:
        thr = thr_by_stat.get(g.get('stat_type', ''), thr_by_stat['_global'])
        tier = assign(float(g['confidence_score']), thr)
        tally[tier][0] += 1 if g['hit'] else 0
        tally[tier][1] += 1

    print(f"\n  Held-out tier performance (breakeven @ -110 = {BREAKEVEN:.1%}):")
    print(f"  {'TIER':<6}{'N':>7}{'HIT':>8}{'EV/$1':>9}")
    for tier in ['LOCK', 'PLAY', 'FADE']:
        hits, n = tally[tier]
        if n == 0:
            print(f"  {tier:<6}{0:>7}{'--':>8}{'--':>9}"); continue
        hr = hits / n
        ev = hr * (100/110) - (1 - hr)
        print(f"  {tier:<6}{n:>7}{hr:>7.1%}{ev:>+9.3f}")

    lock_hr = (tally['LOCK'][0] / tally['LOCK'][1]) if tally['LOCK'][1] else 0
    play_hr = (tally['PLAY'][0] / tally['PLAY'][1]) if tally['PLAY'][1] else 0
    print(f"\n  ADOPTION CHECK: LOCK {lock_hr:.1%} (target 60%), PLAY {play_hr:.1%} (target 55%)")
    print("  Adopt if both clear breakeven (52.4%) with margin and volumes are non-trivial.")

if __name__ == '__main__':
    main()
