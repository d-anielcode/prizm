"""
Prizm Model Diagnostic Pipeline
================================
Analyzes where the v10 confidence model succeeds and fails.
Reads graded props from Supabase, runs 7 analysis modules, outputs
diagnostic_report.json + terminal summary.

Usage:
    python scripts/model_diagnostic.py
    python scripts/model_diagnostic.py --stat points
    python scripts/model_diagnostic.py --start-date 2026-01-01
"""

import os, sys, json, argparse
from datetime import datetime
from collections import defaultdict

# ── Load .env.local ─────────────────────────────────────────────────────────
env = {}
ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env.local')
try:
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                v = v.strip().strip('"').strip("'")
                env[k.strip()] = v
except FileNotFoundError:
    pass

import requests

SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local")
    sys.exit(1)

SB_HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
}


def sb_get_all(table, params=''):
    """Paginated fetch from Supabase REST API (1000 rows per page)."""
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


STAT_TYPES = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'three_pointers']
CONFIDENCE_TIERS = ['LOCK', 'PLAY', 'LEAN', 'FADE']


def parse_args():
    parser = argparse.ArgumentParser(description='Prizm Model Diagnostic Pipeline')
    parser.add_argument('--stat', choices=STAT_TYPES, help='Analyze a single stat type')
    parser.add_argument('--start-date', help='Start date filter (YYYY-MM-DD)')
    parser.add_argument('--end-date', help='End date filter (YYYY-MM-DD)')
    return parser.parse_args()


def main():
    args = parse_args()
    print("Prizm Model Diagnostic Pipeline")
    print("=" * 60)

    # ── Load data ────────────────────────────────────────────────────────────
    print("\n[1/2] Loading graded props from prop_grades...")
    grades = sb_get_all('prop_grades', 'order=game_date.desc')

    # Filter out DNP (hit is null)
    grades = [g for g in grades if g.get('hit') is not None]

    # Apply date filters
    if args.start_date:
        grades = [g for g in grades if g['game_date'] >= args.start_date]
    if args.end_date:
        grades = [g for g in grades if g['game_date'] <= args.end_date]

    # Apply stat filter
    if args.stat:
        grades = [g for g in grades if g['stat_type'] == args.stat]

    if not grades:
        print("  No graded props found. Run /api/grade first.")
        return

    dates = sorted(set(g['game_date'] for g in grades))
    print(f"  {len(grades):,} graded props across {len(dates)} game days ({dates[0]} -> {dates[-1]})")

    print("\n[2/2] Running diagnostic modules...\n")

    report = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'data_range': {
            'start': dates[0],
            'end': dates[-1],
            'game_days': len(dates),
            'total_props': len(grades),
        },
    }

    # Placeholder calls — modules will be added in subsequent tasks
    # report['accuracy_matrix'] = accuracy_matrix(grades)
    # report['over_under_asymmetry'] = over_under_asymmetry(grades)
    # report['calibration_curve'] = calibration_curve(grades)
    # report['high_confidence_misses'] = high_confidence_misses(grades)
    # report['temporal'] = temporal_analysis(grades)
    # report['factor_calibration'] = factor_calibration(grades, logs_by_player, def_stats_map)
    # report['line_movement'] = line_movement_analysis(grades)

    # ── Save report ──────────────────────────────────────────────────────────
    out_path = os.path.join(os.path.dirname(__file__), '..', 'diagnostic_report.json')
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved -> diagnostic_report.json")


if __name__ == '__main__':
    main()
