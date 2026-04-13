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


def accuracy_matrix(grades):
    """Hit rate cross-tab: stat_type x confidence_tier."""
    matrix = {}
    for stat in STAT_TYPES:
        matrix[stat] = {}
        for tier in CONFIDENCE_TIERS:
            subset = [g for g in grades if g['stat_type'] == stat and g.get('confidence_label') == tier]
            n = len(subset)
            if n == 0:
                matrix[stat][tier] = {'hit_rate': None, 'n': 0}
                continue
            hits = sum(1 for g in subset if g['hit'])
            matrix[stat][tier] = {'hit_rate': round(hits / n, 4), 'n': n}

    # Print summary
    print("-- Module 1: Accuracy Matrix (stat x tier) -----------------")
    print(f"  {'Stat':<18}", end='')
    for tier in CONFIDENCE_TIERS:
        print(f"  {tier:>12}", end='')
    print()
    print(f"  {'-'*66}")
    for stat in STAT_TYPES:
        print(f"  {stat:<18}", end='')
        for tier in CONFIDENCE_TIERS:
            cell = matrix[stat][tier]
            if cell['n'] == 0:
                print(f"  {'---':>12}", end='')
            else:
                print(f"  {cell['hit_rate']:.1%} ({cell['n']:>3})", end='')
        print()

    # Overall by tier
    print(f"\n  {'OVERALL':<18}", end='')
    for tier in CONFIDENCE_TIERS:
        subset = [g for g in grades if g.get('confidence_label') == tier]
        if not subset:
            print(f"  {'---':>12}", end='')
        else:
            hr = sum(1 for g in subset if g['hit']) / len(subset)
            print(f"  {hr:.1%} ({len(subset):>3})", end='')
    print("\n")

    return matrix


def over_under_asymmetry(grades):
    """Hit rate by direction (over/under) x stat type."""
    result = {}
    for stat in STAT_TYPES:
        result[stat] = {}
        for direction in ['over', 'under']:
            subset = [g for g in grades if g['stat_type'] == stat and g.get('direction') == direction]
            n = len(subset)
            if n == 0:
                result[stat][direction] = {'hit_rate': None, 'n': 0}
                continue
            hits = sum(1 for g in subset if g['hit'])
            result[stat][direction] = {'hit_rate': round(hits / n, 4), 'n': n}

    # Print summary
    print("-- Module 3: Over/Under Asymmetry --------------------------")
    print(f"  {'Stat':<18} {'OVER':>14} {'UNDER':>14} {'Delta':>8}")
    print(f"  {'-'*56}")
    for stat in STAT_TYPES:
        o = result[stat].get('over', {})
        u = result[stat].get('under', {})
        o_rate = o.get('hit_rate')
        u_rate = u.get('hit_rate')
        o_str = f"{o_rate:.1%} ({o.get('n', 0):>3})" if o_rate is not None else "---"
        u_str = f"{u_rate:.1%} ({u.get('n', 0):>3})" if u_rate is not None else "---"
        delta = ""
        if o_rate is not None and u_rate is not None:
            d = u_rate - o_rate
            delta = f"{d:>+.1%}"
        print(f"  {stat:<18} {o_str:>14} {u_str:>14} {delta:>8}")

    # Overall
    o_all = [g for g in grades if g.get('direction') == 'over']
    u_all = [g for g in grades if g.get('direction') == 'under']
    o_hr = sum(1 for g in o_all if g['hit']) / len(o_all) if o_all else 0
    u_hr = sum(1 for g in u_all if g['hit']) / len(u_all) if u_all else 0
    print(f"\n  {'OVERALL':<18} {o_hr:.1%} ({len(o_all):>3})   {u_hr:.1%} ({len(u_all):>3})   {u_hr - o_hr:>+.1%}")
    print()

    return result


def calibration_curve(grades):
    """Confidence score buckets vs actual hit rate."""
    buckets = []
    for lo in range(30, 90, 5):
        hi = lo + 5
        subset = [g for g in grades if g.get('confidence_score') is not None
                  and lo <= g['confidence_score'] < hi]
        if not subset:
            continue
        hits = sum(1 for g in subset if g['hit'])
        buckets.append({
            'bucket': f"{lo}-{hi}",
            'predicted_rate': round((lo + hi) / 2 / 100, 3),
            'actual_rate': round(hits / len(subset), 4),
            'n': len(subset),
        })

    # Print summary
    print("-- Module 4: Calibration Curve -----------------------------")
    print(f"  {'Bucket':<10} {'Predicted':>10} {'Actual':>10} {'N':>6} {'Gap':>8}")
    print(f"  {'-'*48}")
    for b in buckets:
        gap = b['actual_rate'] - b['predicted_rate']
        marker = '!!' if abs(gap) > 0.10 else '  '
        print(f"  {b['bucket']:<10} {b['predicted_rate']:>9.1%} {b['actual_rate']:>9.1%} {b['n']:>6} {gap:>+7.1%} {marker}")
    print()

    return buckets


def high_confidence_misses(grades):
    """Profile LOCK + PLAY misses to find common failure patterns."""
    misses = [g for g in grades
              if g.get('confidence_label') in ('LOCK', 'PLAY') and not g['hit']]

    by_stat = defaultdict(int)
    for m in misses:
        by_stat[m['stat_type']] += 1

    by_dir = defaultdict(int)
    for m in misses:
        by_dir[m.get('direction', 'unknown')] += 1

    by_stat_dir = defaultdict(int)
    for m in misses:
        by_stat_dir[f"{m['stat_type']}_{m.get('direction', '?')}"] += 1

    by_player = defaultdict(int)
    for m in misses:
        by_player[m['player_name']] += 1
    top_miss_players = sorted(by_player.items(), key=lambda x: -x[1])[:10]

    total_hc = len([g for g in grades if g.get('confidence_label') in ('LOCK', 'PLAY')])
    print("-- Module 5: High-Confidence Misses ------------------------")
    print(f"  {len(misses)} misses out of {total_hc} LOCK+PLAY props ({len(misses)/total_hc:.1%} miss rate)\n")

    print(f"  By stat type:")
    for stat in STAT_TYPES:
        n = by_stat.get(stat, 0)
        if n > 0:
            print(f"    {stat:<18} {n:>4} misses")

    print(f"\n  By direction:")
    for d in ['over', 'under']:
        n = by_dir.get(d, 0)
        print(f"    {d:<18} {n:>4} misses")

    print(f"\n  Top 10 players with most LOCK/PLAY misses:")
    for player, count in top_miss_players:
        print(f"    {player:<25} {count:>3} misses")
    print()

    return {
        'total_misses': len(misses),
        'total_high_confidence': total_hc,
        'miss_rate': round(len(misses) / total_hc, 4) if total_hc > 0 else None,
        'by_stat': dict(by_stat),
        'by_direction': dict(by_dir),
        'by_stat_direction': dict(by_stat_dir),
        'top_miss_players': [{'player': p, 'misses': c} for p, c in top_miss_players],
    }


def temporal_analysis(grades):
    """Accuracy by month and by week — detect drift and seasonal patterns."""
    by_month = defaultdict(list)
    for g in grades:
        month = g['game_date'][:7]
        by_month[month].append(g)

    by_week = defaultdict(list)
    for g in grades:
        try:
            dt = datetime.strptime(g['game_date'], '%Y-%m-%d')
            week_key = dt.strftime('%Y-W%W')
            by_week[week_key].append(g)
        except ValueError:
            pass

    monthly = []
    for month in sorted(by_month.keys()):
        props = by_month[month]
        hits = sum(1 for g in props if g['hit'])
        monthly.append({
            'month': month,
            'hit_rate': round(hits / len(props), 4),
            'n': len(props),
        })

    weekly = []
    for week in sorted(by_week.keys()):
        props = by_week[week]
        if len(props) < 5:
            continue
        hits = sum(1 for g in props if g['hit'])
        weekly.append({
            'week': week,
            'hit_rate': round(hits / len(props), 4),
            'n': len(props),
        })

    print("-- Module 7: Temporal Analysis -----------------------------")
    print(f"  Monthly accuracy:")
    print(f"  {'Month':<10} {'Hit Rate':>10} {'N':>6}")
    print(f"  {'-'*30}")
    for m in monthly:
        print(f"  {m['month']:<10} {m['hit_rate']:>9.1%} {m['n']:>6}")

    if len(weekly) > 3:
        print(f"\n  Weekly accuracy (min 5 props):")
        print(f"  {'Week':<12} {'Hit Rate':>10} {'N':>6}")
        print(f"  {'-'*32}")
        for w in weekly:
            print(f"  {w['week']:<12} {w['hit_rate']:>9.1%} {w['n']:>6}")

    half = len(grades) // 2
    first_half = grades[:half]
    second_half = grades[half:]
    hr1 = sum(1 for g in first_half if g['hit']) / len(first_half) if first_half else 0
    hr2 = sum(1 for g in second_half if g['hit']) / len(second_half) if second_half else 0
    drift = hr2 - hr1
    print(f"\n  Drift detection: first half {hr1:.1%} -> second half {hr2:.1%} (delta {drift:>+.1%})")
    print()

    return {
        'monthly': monthly,
        'weekly': weekly,
        'drift': {
            'first_half_hit_rate': round(hr1, 4),
            'second_half_hit_rate': round(hr2, 4),
            'delta': round(drift, 4),
        },
    }


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

    report['accuracy_matrix'] = accuracy_matrix(grades)
    report['over_under_asymmetry'] = over_under_asymmetry(grades)
    report['calibration_curve'] = calibration_curve(grades)
    report['high_confidence_misses'] = high_confidence_misses(grades)
    report['temporal'] = temporal_analysis(grades)
    # report['factor_calibration'] = factor_calibration(grades, logs_by_player, def_stats_map)
    # report['line_movement'] = line_movement_analysis(grades)

    # ── Save report ──────────────────────────────────────────────────────────
    out_path = os.path.join(os.path.dirname(__file__), '..', 'diagnostic_report.json')
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved -> diagnostic_report.json")


if __name__ == '__main__':
    main()
