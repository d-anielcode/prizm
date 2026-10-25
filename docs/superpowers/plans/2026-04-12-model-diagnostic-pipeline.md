# Model Diagnostic Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/model_diagnostic.py` — an error analysis pipeline that identifies where the v10 confidence model fails by stat type, factor, direction, time period, and line movement.

**Architecture:** A single Python script with 7 analysis functions, each producing a section of a JSON report. Reuses the Supabase helper pattern from the existing `scripts/backtest.py`. Reads from `prop_grades`, `player_game_logs`, `team_defense_stats`, `historical_prop_lines`, and `prop_history`.

**Tech Stack:** Python 3, requests, numpy, scikit-learn (all already used in backtest.py)

---

### Task 1: Script Skeleton + Supabase Helpers + CLI Args

**Files:**
- Create: `scripts/model_diagnostic.py`

- [ ] **Step 1: Create the script with env loading, Supabase helpers, and argparse**

```python
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
    print(f"  {len(grades):,} graded props across {len(dates)} game days ({dates[0]} → {dates[-1]})")

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

    # Module 1: Accuracy matrix
    report['accuracy_matrix'] = accuracy_matrix(grades)

    # Module 2: Factor calibration (placeholder — implemented in Task 3)
    # Module 3: Over/under asymmetry
    report['over_under_asymmetry'] = over_under_asymmetry(grades)

    # Module 4: Calibration curve
    report['calibration_curve'] = calibration_curve(grades)

    # Module 5: High confidence misses
    report['high_confidence_misses'] = high_confidence_misses(grades)

    # Module 6: Line movement (placeholder — implemented in Task 5)
    # Module 7: Temporal analysis
    report['temporal'] = temporal_analysis(grades)

    # ── Save report ──────────────────────────────────────────────────────────
    out_path = os.path.join(os.path.dirname(__file__), '..', 'diagnostic_report.json')
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved → diagnostic_report.json")


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Run the script to verify it loads data**

Run: `python scripts/model_diagnostic.py`
Expected: Prints count of graded props and "Running diagnostic modules..." — will error on missing functions (accuracy_matrix etc.) which we implement next.

- [ ] **Step 3: Commit skeleton**

```bash
git add scripts/model_diagnostic.py
git commit -m "feat: add model diagnostic pipeline skeleton with CLI args and data loading"
```

---

### Task 2: Accuracy Matrix + Over/Under Asymmetry + Calibration Curve

**Files:**
- Modify: `scripts/model_diagnostic.py`

These three modules only need `prop_grades` data (already loaded in main), so they're straightforward.

- [ ] **Step 1: Add accuracy_matrix() function**

Insert above `main()`:

```python
def accuracy_matrix(grades):
    """Hit rate cross-tab: stat_type × confidence_tier."""
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
    print("── Module 1: Accuracy Matrix (stat × tier) ─────────────────")
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
                print(f"  {'—':>12}", end='')
            else:
                print(f"  {cell['hit_rate']:.1%} ({cell['n']:>3})", end='')
        print()

    # Overall by tier
    print(f"\n  {'OVERALL':<18}", end='')
    for tier in CONFIDENCE_TIERS:
        subset = [g for g in grades if g.get('confidence_label') == tier]
        if not subset:
            print(f"  {'—':>12}", end='')
        else:
            hr = sum(1 for g in subset if g['hit']) / len(subset)
            print(f"  {hr:.1%} ({len(subset):>3})", end='')
    print("\n")

    return matrix
```

- [ ] **Step 2: Add over_under_asymmetry() function**

Insert after `accuracy_matrix`:

```python
def over_under_asymmetry(grades):
    """Hit rate by direction (over/under) × stat type."""
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
    print("── Module 3: Over/Under Asymmetry ──────────────────────────")
    print(f"  {'Stat':<18} {'OVER':>14} {'UNDER':>14} {'Delta':>8}")
    print(f"  {'-'*56}")
    for stat in STAT_TYPES:
        o = result[stat].get('over', {})
        u = result[stat].get('under', {})
        o_rate = o.get('hit_rate')
        u_rate = u.get('hit_rate')
        o_str = f"{o_rate:.1%} ({o.get('n', 0):>3})" if o_rate is not None else "—"
        u_str = f"{u_rate:.1%} ({u.get('n', 0):>3})" if u_rate is not None else "—"
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
```

- [ ] **Step 3: Add calibration_curve() function**

Insert after `over_under_asymmetry`:

```python
def calibration_curve(grades):
    """Confidence score buckets vs actual hit rate."""
    buckets = []
    # 5-point buckets from 30 to 90
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
    print("── Module 4: Calibration Curve ─────────────────────────────")
    print(f"  {'Bucket':<10} {'Predicted':>10} {'Actual':>10} {'N':>6} {'Gap':>8}")
    print(f"  {'-'*48}")
    for b in buckets:
        gap = b['actual_rate'] - b['predicted_rate']
        marker = '⚠' if abs(gap) > 0.10 else ' '
        print(f"  {b['bucket']:<10} {b['predicted_rate']:>9.1%} {b['actual_rate']:>9.1%} {b['n']:>6} {gap:>+7.1%} {marker}")
    print()

    return buckets
```

- [ ] **Step 4: Add high_confidence_misses() function**

Insert after `calibration_curve`:

```python
def high_confidence_misses(grades):
    """Profile LOCK + PLAY misses to find common failure patterns."""
    misses = [g for g in grades
              if g.get('confidence_label') in ('LOCK', 'PLAY') and not g['hit']]

    # Count by stat type
    by_stat = defaultdict(int)
    for m in misses:
        by_stat[m['stat_type']] += 1

    # Count by direction
    by_dir = defaultdict(int)
    for m in misses:
        by_dir[m.get('direction', 'unknown')] += 1

    # Count by stat × direction
    by_stat_dir = defaultdict(int)
    for m in misses:
        by_stat_dir[f"{m['stat_type']}_{m.get('direction', '?')}"] += 1

    # Top players with most high-confidence misses
    by_player = defaultdict(int)
    for m in misses:
        by_player[m['player_name']] += 1
    top_miss_players = sorted(by_player.items(), key=lambda x: -x[1])[:10]

    # Print summary
    total_hc = len([g for g in grades if g.get('confidence_label') in ('LOCK', 'PLAY')])
    print("── Module 5: High-Confidence Misses ────────────────────────")
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
```

- [ ] **Step 5: Add temporal_analysis() function**

Insert after `high_confidence_misses`:

```python
def temporal_analysis(grades):
    """Accuracy by month and by week — detect drift and seasonal patterns."""
    # Group by month
    by_month = defaultdict(list)
    for g in grades:
        month = g['game_date'][:7]  # YYYY-MM
        by_month[month].append(g)

    # Group by ISO week
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

    # Print summary
    print("── Module 7: Temporal Analysis ─────────────────────────────")
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

    # Drift detection: compare first half vs second half
    half = len(grades) // 2
    first_half = grades[:half]
    second_half = grades[half:]
    hr1 = sum(1 for g in first_half if g['hit']) / len(first_half) if first_half else 0
    hr2 = sum(1 for g in second_half if g['hit']) / len(second_half) if second_half else 0
    drift = hr2 - hr1
    print(f"\n  Drift detection: first half {hr1:.1%} → second half {hr2:.1%} (Δ {drift:>+.1%})")
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
```

- [ ] **Step 6: Run the script to verify modules 1, 3, 4, 5, 7 work**

Run: `python scripts/model_diagnostic.py`
Expected: All five modules print output, no errors. The report is saved to `diagnostic_report.json`.

- [ ] **Step 7: Commit**

```bash
git add scripts/model_diagnostic.py
git commit -m "feat: add accuracy matrix, over/under, calibration, miss analysis, temporal modules"
```

---

### Task 3: Factor Calibration Module

**Files:**
- Modify: `scripts/model_diagnostic.py`

This module needs to recompute factor scores for each graded prop by joining `prop_grades` with `player_game_logs` and `team_defense_stats`. We reuse the factor functions from `backtest.py`.

- [ ] **Step 1: Add factor computation functions (copied from backtest.py with minor renames)**

Insert after the `CONFIDENCE_TIERS` definition but before `accuracy_matrix`:

```python
import re

def get_stat(log, stat_type):
    return {
        'points':         float(log.get('points', 0) or 0),
        'rebounds':       float(log.get('rebounds', 0) or 0),
        'assists':        float(log.get('assists', 0) or 0),
        'steals':         float(log.get('steals', 0) or 0),
        'blocks':         float(log.get('blocks', 0) or 0),
        'three_pointers': float(log.get('fg3m', 0) or 0),
        'pra':            float(log.get('pra', 0) or 0),
    }.get(stat_type, 0.0)


def extract_opponent(matchup):
    parts = re.split(r'\s+vs\.\s+|\s+@\s+', matchup)
    return parts[1].strip().upper() if len(parts) >= 2 else None


def clamp(x, lo=0.05, hi=0.95):
    return min(hi, max(lo, x))


def factor_last_n_hitrate(prior, stat_type, line, direction, n):
    sl = prior[:n]
    if len(sl) < 3:
        return None
    hits = sum(1 for g in sl if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(sl)


def factor_cushion(prior, stat_type, line, direction):
    vals = [get_stat(g, stat_type) for g in prior]
    vals = [v for v in vals if v >= 0]
    if len(vals) < 5:
        return 0.5
    avg = sum(vals) / len(vals)
    pct = (avg - line) / max(line, 1)
    raw = clamp(pct / 0.60 + 0.50)
    return raw if direction == 'over' else 1 - raw


def factor_trend(prior, stat_type, direction):
    l5  = [get_stat(g, stat_type) for g in prior[:5]]
    l20 = [get_stat(g, stat_type) for g in prior[:20]]
    if len(l5) < 3 or len(l20) < 8:
        return 0.5
    avg5  = sum(l5)  / len(l5)
    avg20 = sum(l20) / len(l20)
    if avg20 == 0:
        return 0.5
    trend_pct = (avg5 - avg20) / avg20
    raw = clamp(trend_pct / 0.40 + 0.50)
    return raw if direction == 'over' else 1 - raw


def factor_matchup(def_stats_map, opp_abbr, stat_type, direction):
    if not opp_abbr or opp_abbr not in def_stats_map:
        return 0.5
    rank_key = {
        'points': 'pts_rank', 'rebounds': 'reb_rank', 'assists': 'ast_rank',
        'steals': 'stl_rank', 'blocks': 'blk_rank',
        'three_pointers': 'fg3m_rank', 'pra': 'pts_rank'
    }.get(stat_type, 'pts_rank')
    rank = def_stats_map[opp_abbr].get(rank_key, 15)
    raw = (rank - 1) / 29
    return raw if direction == 'over' else 1 - raw


def factor_vs_opponent(prior, stat_type, line, direction, opp_abbr):
    if not opp_abbr:
        return 0.5
    vs_logs = [g for g in prior if extract_opponent(g.get('matchup', '')) == opp_abbr]
    n = len(vs_logs)
    if n < 2:
        return 0.5
    hits = sum(1 for g in vs_logs if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    raw_rate = hits / n
    weight = min(0.80, 0.15 + n * 0.13)
    return raw_rate * weight + 0.5 * (1 - weight)


def factor_home_away(prior, stat_type, line, direction, is_home):
    filtered = [g for g in prior if g.get('is_home') == is_home]
    if len(filtered) < 5:
        return 0.5
    hits = sum(1 for g in filtered if (get_stat(g, stat_type) > line if direction == 'over' else get_stat(g, stat_type) < line))
    return hits / len(filtered)


def factor_rest_days(prior_logs, test_game_date):
    if not prior_logs:
        return 0.5
    try:
        last = datetime.strptime(prior_logs[0]['game_date'], '%Y-%m-%d')
        curr = datetime.strptime(test_game_date, '%Y-%m-%d')
        rest = (curr - last).days - 1
        if rest <= 0: return 0.25
        if rest == 1: return 0.50
        if rest == 2: return 0.60
        return 0.55
    except Exception:
        return 0.5


FACTOR_NAMES = [
    'last10HitRate', 'matchupEdge', 'seasonCushion', 'vsOpponent',
    'homeAway', 'trend', 'last20HitRate', 'restDays',
]
```

- [ ] **Step 2: Add the factor_calibration() function that computes factors for each graded prop**

Insert after the factor functions:

```python
def factor_calibration(grades, logs_by_player, def_stats_map):
    """
    For each graded prop, recompute factor scores using game logs, then
    measure how predictive each factor is (point-biserial correlation + AUC).
    """
    import numpy as np

    cases = []
    skipped = 0

    for g in grades:
        player = g['player_name']
        stat = g['stat_type']
        line = float(g['line'])
        direction = g.get('direction', 'over')
        game_date = g['game_date']
        hit = 1 if g['hit'] else 0

        if player not in logs_by_player:
            skipped += 1
            continue

        all_logs = sorted(logs_by_player[player], key=lambda l: l['game_date'])
        prior = list(reversed([l for l in all_logs if l['game_date'] < game_date]))

        if len(prior) < 10:
            skipped += 1
            continue

        # Figure out opponent and home/away from the game log on this date
        target = next((l for l in all_logs if l['game_date'] == game_date), None)
        if not target:
            skipped += 1
            continue
        opp_abbr = extract_opponent(target.get('matchup', ''))
        is_home = target.get('is_home', False)

        features = [
            factor_last_n_hitrate(prior, stat, line, direction, 10) or 0.5,
            factor_matchup(def_stats_map, opp_abbr, stat, direction),
            factor_cushion(prior, stat, line, direction),
            factor_vs_opponent(prior, stat, line, direction, opp_abbr),
            factor_home_away(prior, stat, line, direction, is_home),
            factor_trend(prior, stat, direction),
            factor_last_n_hitrate(prior, stat, line, direction, 20) or 0.5,
            factor_rest_days(prior, game_date),
        ]
        cases.append({'features': features, 'label': hit})

    if len(cases) < 30:
        print("── Module 2: Factor Calibration ────────────────────────────")
        print(f"  Not enough matched cases ({len(cases)}) — need 30+. Skipped {skipped}.")
        return {'error': 'insufficient_data', 'matched': len(cases), 'skipped': skipped}

    X = np.array([c['features'] for c in cases])
    y = np.array([c['label'] for c in cases])

    results = []
    for i, name in enumerate(FACTOR_NAMES):
        col = X[:, i]
        # Point-biserial correlation
        from scipy.stats import pointbiserialr
        corr, pval = pointbiserialr(y, col)

        # AUC
        from sklearn.metrics import roc_auc_score
        try:
            auc = roc_auc_score(y, col)
        except ValueError:
            auc = 0.5

        # Simple threshold accuracy
        preds = (col > 0.5).astype(int)
        acc = (preds == y).mean()

        results.append({
            'factor': name,
            'correlation': round(float(corr), 4),
            'p_value': round(float(pval), 6),
            'auc': round(float(auc), 4),
            'threshold_accuracy': round(float(acc), 4),
            'anti_correlated': corr < -0.01,
        })

    # Sort by AUC descending
    results.sort(key=lambda r: -r['auc'])

    # Print summary
    print("── Module 2: Factor Calibration ────────────────────────────")
    print(f"  {len(cases)} matched props (skipped {skipped} — no logs or < 10 prior games)\n")
    print(f"  {'Factor':<18} {'AUC':>6} {'Corr':>7} {'p-val':>9} {'Acc':>6} {'Flag':>6}")
    print(f"  {'-'*58}")
    for r in results:
        flag = '⚠ NEG' if r['anti_correlated'] else ''
        print(f"  {r['factor']:<18} {r['auc']:>5.3f} {r['correlation']:>+6.3f} {r['p_value']:>9.6f} {r['threshold_accuracy']:>5.1%} {flag}")
    print()

    return {
        'matched_props': len(cases),
        'skipped': skipped,
        'factors': results,
    }
```

- [ ] **Step 3: Update main() to load game logs + defense stats and call factor_calibration**

Replace the `# Module 2` placeholder line and add data loading. In `main()`, after the `grades` loading block, add:

```python
    # Load game logs for factor recomputation
    print("  Loading game logs...")
    raw_logs = sb_get_all('player_game_logs', 'order=game_date.desc')
    logs_by_player = defaultdict(list)
    for log in raw_logs:
        if log.get('player_name') and log.get('game_date'):
            logs_by_player[log['player_name']].append(log)
    print(f"  {len(raw_logs):,} game log rows for {len(logs_by_player)} players")

    # Load team defense stats
    print("  Loading team defense stats...")
    def_rows = sb_get_all('team_defense_stats')
    def_stats_map = {row['team_abbreviation']: row for row in def_rows}
    print(f"  {len(def_stats_map)} teams loaded")
```

And replace the `# Module 2` comment with:

```python
    report['factor_calibration'] = factor_calibration(grades, logs_by_player, def_stats_map)
```

- [ ] **Step 4: Run the script to verify factor calibration works**

Run: `python scripts/model_diagnostic.py`
Expected: Module 2 prints a ranked table of factors by AUC. Warnings for anti-correlated factors if any.

- [ ] **Step 5: Commit**

```bash
git add scripts/model_diagnostic.py
git commit -m "feat: add factor calibration module with AUC + correlation analysis"
```

---

### Task 4: Line Movement Analysis Module

**Files:**
- Modify: `scripts/model_diagnostic.py`

This module joins `prop_grades` with `historical_prop_lines` and `prop_history` to check if line movement correlates with outcomes.

- [ ] **Step 1: Add line_movement_analysis() function**

Insert after `temporal_analysis`:

```python
def line_movement_analysis(grades):
    """
    Check if line movement correlates with outcomes.
    Uses prop_history snapshots to detect line changes between days.
    """
    # Load historical prop lines
    print("  Loading historical_prop_lines...")
    hist_lines = sb_get_all('historical_prop_lines', 'order=game_date.desc')

    if not hist_lines:
        print("── Module 6: Line Movement Analysis ────────────────────────")
        print("  No historical_prop_lines data found. Skipping.\n")
        return {'error': 'no_data'}

    # Index lines by (player, stat, game_date) → list of lines over time
    from collections import defaultdict
    lines_index = defaultdict(list)
    for h in hist_lines:
        key = (h.get('player_name', ''), h.get('stat_type', ''), h.get('game_date', ''))
        lines_index[key].append(h)

    # For each graded prop, check if we have line history
    moved_props = []
    for g in grades:
        key = (g['player_name'], g['stat_type'], g['game_date'])
        lines = lines_index.get(key, [])
        if len(lines) < 2:
            continue

        # Sort by snapshot time if available, else by line value
        lines_sorted = sorted(lines, key=lambda l: l.get('line', 0))
        first_line = float(lines_sorted[0].get('line', 0))
        last_line = float(lines_sorted[-1].get('line', 0))
        move = last_line - first_line

        if abs(move) < 0.5:
            continue

        direction = g.get('direction', 'over')
        # Line moved up = harder for over, easier for under
        move_helps = (move < 0 and direction == 'over') or (move > 0 and direction == 'under')

        moved_props.append({
            'hit': g['hit'],
            'move': move,
            'move_helps': move_helps,
            'stat': g['stat_type'],
            'direction': direction,
        })

    if not moved_props:
        print("── Module 6: Line Movement Analysis ────────────────────────")
        print("  Not enough props with line movement (≥0.5) to analyze.\n")
        return {'error': 'insufficient_movement_data', 'total_lines': len(hist_lines)}

    # Compare accuracy: line moved in favorable vs unfavorable direction
    favorable = [p for p in moved_props if p['move_helps']]
    unfavorable = [p for p in moved_props if not p['move_helps']]

    fav_hr = sum(1 for p in favorable if p['hit']) / len(favorable) if favorable else 0
    unfav_hr = sum(1 for p in unfavorable if p['hit']) / len(unfavorable) if unfavorable else 0

    print("── Module 6: Line Movement Analysis ────────────────────────")
    print(f"  Props with line movement ≥0.5: {len(moved_props)}")
    print(f"  Line moved favorably:   {fav_hr:.1%} hit rate ({len(favorable)} props)")
    print(f"  Line moved unfavorably: {unfav_hr:.1%} hit rate ({len(unfavorable)} props)")
    print(f"  Delta: {fav_hr - unfav_hr:>+.1%}")
    print()

    return {
        'total_with_movement': len(moved_props),
        'favorable': {'hit_rate': round(fav_hr, 4), 'n': len(favorable)},
        'unfavorable': {'hit_rate': round(unfav_hr, 4), 'n': len(unfavorable)},
        'delta': round(fav_hr - unfav_hr, 4),
    }
```

- [ ] **Step 2: Update main() to call line_movement_analysis**

Replace the `# Module 6` placeholder comment with:

```python
    report['line_movement'] = line_movement_analysis(grades)
```

- [ ] **Step 3: Run to verify**

Run: `python scripts/model_diagnostic.py`
Expected: Module 6 prints line movement analysis (or a "no data" message if `historical_prop_lines` is empty).

- [ ] **Step 4: Commit**

```bash
git add scripts/model_diagnostic.py
git commit -m "feat: add line movement analysis module"
```

---

### Task 5: Final Summary + Recommendations Engine

**Files:**
- Modify: `scripts/model_diagnostic.py`

- [ ] **Step 1: Add a print_summary() function that synthesizes findings**

Insert before `main()`:

```python
def print_summary(report):
    """Print a high-level summary with actionable recommendations."""
    print("=" * 60)
    print("  DIAGNOSTIC SUMMARY")
    print("=" * 60)

    recommendations = []

    # 1. Find worst stat/tier combos from accuracy matrix
    matrix = report.get('accuracy_matrix', {})
    worst_combos = []
    for stat, tiers in matrix.items():
        for tier in ['LOCK', 'PLAY']:
            cell = tiers.get(tier, {})
            if cell.get('n', 0) >= 5 and cell.get('hit_rate') is not None:
                target = 0.65 if tier == 'LOCK' else 0.50
                if cell['hit_rate'] < target:
                    worst_combos.append((stat, tier, cell['hit_rate'], cell['n']))

    if worst_combos:
        worst_combos.sort(key=lambda x: x[2])
        print("\n  Underperforming stat/tier combos (below target):")
        for stat, tier, hr, n in worst_combos:
            target = '65%' if tier == 'LOCK' else '50%'
            print(f"    {tier} {stat}: {hr:.1%} (target {target}, n={n})")
            recommendations.append(f"Raise {tier} threshold for {stat} or add stat-specific penalty")

    # 2. Over/under asymmetry
    ou = report.get('over_under_asymmetry', {})
    for stat, dirs in ou.items():
        o = dirs.get('over', {})
        u = dirs.get('under', {})
        if o.get('n', 0) >= 10 and u.get('n', 0) >= 10:
            if o.get('hit_rate') is not None and u.get('hit_rate') is not None:
                gap = u['hit_rate'] - o['hit_rate']
                if gap > 0.10:
                    recommendations.append(f"Increase over bias penalty for {stat} (under outperforms over by {gap:.0%})")

    # 3. Anti-correlated factors
    fc = report.get('factor_calibration', {})
    if isinstance(fc, dict) and 'factors' in fc:
        for f in fc['factors']:
            if f.get('anti_correlated'):
                recommendations.append(f"Factor '{f['factor']}' is anti-correlated — consider reducing its weight or inverting")

    # 4. Calibration issues
    cal = report.get('calibration_curve', [])
    overconfident = [b for b in cal if b['actual_rate'] < b['predicted_rate'] - 0.10 and b['n'] >= 10]
    if overconfident:
        buckets_str = ', '.join(b['bucket'] for b in overconfident)
        recommendations.append(f"Model is overconfident in score ranges: {buckets_str}")

    # 5. Temporal drift
    drift = report.get('temporal', {}).get('drift', {})
    if drift.get('delta') is not None and abs(drift['delta']) > 0.05:
        direction = 'improving' if drift['delta'] > 0 else 'degrading'
        recommendations.append(f"Model accuracy is {direction} over time (Δ {drift['delta']:+.1%})")

    # Print recommendations
    if recommendations:
        print(f"\n  Top recommendations:")
        for i, rec in enumerate(recommendations[:8], 1):
            print(f"    {i}. {rec}")
    else:
        print("\n  No major issues detected — model looks well-calibrated.")

    report['recommendations'] = recommendations
    print()
```

- [ ] **Step 2: Call print_summary at the end of main()**

In `main()`, add this line right before the "Save report" section:

```python
    print_summary(report)
```

- [ ] **Step 3: Run the full diagnostic pipeline**

Run: `python scripts/model_diagnostic.py`
Expected: All 7 modules run, summary prints actionable recommendations, `diagnostic_report.json` is saved with all data including recommendations list.

- [ ] **Step 4: Test the --stat filter**

Run: `python scripts/model_diagnostic.py --stat steals`
Expected: All modules only analyze steals props.

- [ ] **Step 5: Commit**

```bash
git add scripts/model_diagnostic.py
git commit -m "feat: add diagnostic summary with actionable recommendations"
```

- [ ] **Step 6: Add diagnostic_report.json to .gitignore**

Check if `.gitignore` exists and add the output file:

```bash
echo "diagnostic_report.json" >> .gitignore
git add .gitignore
git commit -m "chore: gitignore diagnostic_report.json"
```
