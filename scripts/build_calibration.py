"""
Prizm Score Calibration Builder
================================
Reads prop_grades from Supabase, fits an isotonic regression of
predicted score (0-100) -> actual hit rate, and writes
lib/calibration-table.json for runtime use.

The diagnostic pipeline (Module 4) shows the raw confidence_score is
systematically overconfident above 60 (e.g. predicted 72.5% actually
58.2% on 70-75 bucket). Isotonic produces a monotonic remapping so
"score 72" actually means "72% hit rate" historically.

Usage:
    py scripts/build_calibration.py
    py scripts/build_calibration.py --min-n 30      # min samples per bucket
    py scripts/build_calibration.py --start-date 2026-01-01
"""

import os, sys, json, argparse
from datetime import datetime, timezone
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

SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local")
    sys.exit(1)

SB_HEADERS = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}


def sb_get_all(table, params=''):
    rows = []
    offset = 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=SB_HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows


def parse_args():
    p = argparse.ArgumentParser(description='Build score calibration table')
    p.add_argument('--min-n', type=int, default=30, help='Min samples per bucket (default 30)')
    p.add_argument('--start-date', help='Filter grades by start date (YYYY-MM-DD)')
    p.add_argument('--end-date',   help='Filter grades by end date (YYYY-MM-DD)')
    p.add_argument('--out', default='lib/calibration-table.json', help='Output path')
    return p.parse_args()


def main():
    args = parse_args()
    print("Prizm Calibration Builder")
    print("=" * 60)

    print("\n[1/3] Loading prop_grades...")
    grades = sb_get_all('prop_grades')
    grades = [g for g in grades if g.get('hit') is not None and g.get('confidence_score') is not None]
    if args.start_date:
        grades = [g for g in grades if g['game_date'] >= args.start_date]
    if args.end_date:
        grades = [g for g in grades if g['game_date'] <= args.end_date]
    if not grades:
        print("  No graded props found.")
        sys.exit(1)
    dates = sorted(set(g['game_date'] for g in grades))
    print(f"  {len(grades):,} graded props across {len(dates)} game days "
          f"({dates[0]} -> {dates[-1]})")

    # ── 2. Fit isotonic ──────────────────────────────────────────────────────
    print("\n[2/3] Fitting isotonic regression...")
    try:
        import numpy as np
        from sklearn.isotonic import IsotonicRegression
    except ImportError:
        print("  Need scikit-learn + numpy. pip install scikit-learn numpy")
        sys.exit(1)

    scores = np.array([float(g['confidence_score']) for g in grades])
    hits   = np.array([1 if g['hit'] else 0 for g in grades])

    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds='clip')
    iso.fit(scores, hits)

    # Build a 0..100 lookup table at integer points (101 entries).
    grid = np.arange(0, 101, 1)
    calibrated = iso.predict(grid)
    # Express calibrated probability on the same 0..100 scale that scores live on.
    calibrated_score = (calibrated * 100).round(2)

    # Diagnostic table — what each 5-pt bucket maps to, plus the n that supports it.
    print(f"\n  Bucket    Raw -> Calibrated     N      ActualHR (in raw bucket)")
    print(f"  {'-'*60}")
    for lo in range(30, 90, 5):
        hi = lo + 5
        mask = (scores >= lo) & (scores < hi)
        n = int(mask.sum())
        if n < args.min_n:
            continue
        actual_hr = float(hits[mask].mean())
        raw_mid = (lo + hi) / 2.0
        cal_mid = float(iso.predict([raw_mid])[0]) * 100
        print(f"  {lo}-{hi:<5} {raw_mid:>5.1f} -> {cal_mid:>5.1f}     {n:>6,}    {actual_hr*100:>5.1f}%")

    # ── 3. Write calibration table ──────────────────────────────────────────
    out_path = os.path.join(os.path.dirname(__file__), '..', args.out)
    payload = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'data_window': {
            'start': dates[0], 'end': dates[-1],
            'game_days': len(dates), 'graded_props': len(grades),
        },
        'method': 'sklearn.isotonic.IsotonicRegression(y_min=0, y_max=1)',
        'description': (
            'Maps raw confidence_score (0-100) to historically observed hit rate '
            '(0-100). Use applyCalibration() in lib/confidence.ts to remap any '
            'raw score; tier thresholds in confidence-weights.json must be re-tuned '
            'against this calibrated scale before flipping PRIZM_CALIBRATE_SCORES on.'
        ),
        # 101-element array indexed by raw score 0..100.
        'lookup': [float(v) for v in calibrated_score],
    }
    with open(out_path, 'w') as f:
        json.dump(payload, f, indent=2)
    print(f"\n[3/3] Wrote calibration table -> {out_path}")
    print(f"      ({len(payload['lookup'])} entries, isotonic monotone-non-decreasing)")


if __name__ == '__main__':
    main()
