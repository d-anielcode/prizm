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

import os, sys, json, argparse, re
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


# Diagnostic factor surface for AUC + logreg ceiling. Note: last10HitRate is
# included historically for completeness but is NOT in the production weight
# set (scripts/auto_retrain.py:66, lib/confidence.ts). Investigation 2026-05-13
# (scripts/investigate_collinearity.py) confirmed l20-alone beats l10+l20
# combined (AUC 0.5531 vs 0.5504) -- l10 adds noise, not signal, once l20 is
# in the model. The diagnostic keeps reporting it so we can re-evaluate if
# the relationship changes, but the ceiling AUC should be interpreted as
# "ceiling with l10 INCLUDED" -- production AUC without l10 is slightly higher.
FACTOR_NAMES = [
    'last10HitRate', 'matchupEdge', 'seasonCushion', 'vsOpponent',
    'homeAway', 'trend', 'last20HitRate', 'restDays',
]


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
        print("-- Module 2: Factor Calibration ----------------------------------------")
        print(f"  Not enough matched cases ({len(cases)}) -- need 30+. Skipped {skipped}.")
        return {'error': 'insufficient_data', 'matched': len(cases), 'skipped': skipped}

    X = np.array([c['features'] for c in cases])
    y = np.array([c['label'] for c in cases])

    results = []
    for i, name in enumerate(FACTOR_NAMES):
        col = X[:, i]
        # Point-biserial correlation
        try:
            from scipy.stats import pointbiserialr
            corr, pval = pointbiserialr(y, col)
        except ImportError:
            corr, pval = 0.0, 1.0

        # AUC
        try:
            from sklearn.metrics import roc_auc_score
            auc = roc_auc_score(y, col)
        except (ValueError, ImportError):
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
            'anti_correlated': bool(corr < -0.01),
        })

    results.sort(key=lambda r: -r['auc'])

    print("-- Module 2: Factor Calibration ----------------------------------------")
    print(f"  {len(cases)} matched props (skipped {skipped} -- no logs or < 10 prior games)\n")
    print(f"  {'Factor':<18} {'AUC':>6} {'Corr':>7} {'p-val':>9} {'Acc':>6} {'Flag':>6}")
    print(f"  {'-'*58}")
    for r in results:
        flag = '!! NEG' if r['anti_correlated'] else ''
        print(f"  {r['factor']:<18} {r['auc']:>5.3f} {r['correlation']:>+6.3f} {r['p_value']:>9.6f} {r['threshold_accuracy']:>5.1%} {flag}")
    print()

    return {
        'matched_props': len(cases),
        'skipped': skipped,
        'factors': results,
    }


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


def line_dispersion_analysis(grades):
    """
    Module 6 — Cross-book line dispersion vs hit rate.

    historical_prop_lines is keyed (game_date, player, stat, direction, sportsbook),
    so multiple rows per (player, stat, date) only appear when different sportsbooks
    posted different lines. There is no chronological snapshot data — this measures
    cross-book disagreement, NOT temporal line movement.

    Question: when sportsbooks disagree on a line (high dispersion), do props hit
    at a different rate than when books agree? Larger dispersion implies the market
    is uncertain — could be edge, could be noise.

    NOTE: previous implementation (pre-2026-05) called this "line_movement" and
    sorted by line value, making `move = last - first` always >= 0 — the
    "favorable" bucket was structurally always n=0. Renamed and re-defined here.
    """
    print("  Loading historical_prop_lines...")
    hist_lines = sb_get_all('historical_prop_lines', 'order=game_date.desc')

    if not hist_lines:
        print("-- Module 6: Line Dispersion Analysis ----------------------------------")
        print("  No historical_prop_lines data found. Skipping.\n")
        return {'error': 'no_data'}

    # Index by (player, stat, game_date, direction) — only books posting the same
    # side of the same prop are comparable. Different directions get their own group.
    lines_index = defaultdict(list)
    for h in hist_lines:
        key = (
            h.get('player_name', ''),
            h.get('stat_type', ''),
            h.get('game_date', ''),
            h.get('direction', 'over'),
        )
        try:
            line = float(h.get('line', 0))
        except (TypeError, ValueError):
            continue
        lines_index[key].append(line)

    # For each graded prop, find the dispersion across books for the matching side.
    by_dispersion = []
    for g in grades:
        key = (g['player_name'], g['stat_type'], g['game_date'], g.get('direction', 'over'))
        lines = lines_index.get(key, [])
        if len(lines) < 2:
            continue
        dispersion = max(lines) - min(lines)
        try:
            graded_line = float(g.get('line', 0))
        except (TypeError, ValueError):
            continue
        # Did we score against the best (most favorable) line, or a worse one?
        if g.get('direction', 'over') == 'over':
            best_line = min(lines)            # lower line = easier OVER
            line_disadvantage = graded_line - best_line
        else:
            best_line = max(lines)            # higher line = easier UNDER
            line_disadvantage = best_line - graded_line
        by_dispersion.append({
            'hit': g['hit'],
            'dispersion': dispersion,
            'line_disadvantage': line_disadvantage,
            'stat': g['stat_type'],
        })

    if not by_dispersion:
        print("-- Module 6: Line Dispersion Analysis ----------------------------------")
        print("  No graded props have multi-book line data. Skipping.\n")
        return {'error': 'insufficient_data', 'total_lines': len(hist_lines)}

    # Bucketize by dispersion magnitude.
    buckets = [
        ('agree (0)',         lambda d: d == 0),
        ('narrow (0-0.5]',    lambda d: 0 < d <= 0.5),
        ('moderate (0.5-1]',  lambda d: 0.5 < d <= 1.0),
        ('wide (>1)',         lambda d: d > 1.0),
    ]
    bucket_results = []
    for label, pred in buckets:
        sub = [p for p in by_dispersion if pred(p['dispersion'])]
        if not sub:
            bucket_results.append({'bucket': label, 'n': 0, 'hit_rate': None})
            continue
        hr = sum(1 for p in sub if p['hit']) / len(sub)
        bucket_results.append({'bucket': label, 'n': len(sub), 'hit_rate': round(hr, 4)})

    # Did we score against an inferior line? (Did we miss a better number elsewhere?)
    got_best = [p for p in by_dispersion if p['line_disadvantage'] <= 0.001]
    got_worse = [p for p in by_dispersion if p['line_disadvantage'] > 0.001]
    best_hr = sum(1 for p in got_best if p['hit']) / len(got_best) if got_best else None
    worse_hr = sum(1 for p in got_worse if p['hit']) / len(got_worse) if got_worse else None

    print("-- Module 6: Line Dispersion Analysis ----------------------------------")
    print(f"  Props with multi-book line data: {len(by_dispersion):,}\n")
    print(f"  {'Bucket':<22} {'N':>8} {'Hit Rate':>10}")
    print(f"  {'-'*42}")
    for r in bucket_results:
        n_str = f"{r['n']:>8}"
        hr_str = f"{r['hit_rate']:>9.1%}" if r['hit_rate'] is not None else "        ---"
        print(f"  {r['bucket']:<22} {n_str} {hr_str}")
    print()
    if best_hr is not None and worse_hr is not None:
        delta = best_hr - worse_hr
        print(f"  Scored against best line:  {best_hr:.1%} ({len(got_best):,})")
        print(f"  Scored against worse line: {worse_hr:.1%} ({len(got_worse):,})")
        print(f"  Delta:                     {delta:>+.1%}")
    print()

    return {
        'total_with_multibook_data': len(by_dispersion),
        'by_dispersion_bucket': bucket_results,
        'got_best_line':  {'hit_rate': round(best_hr, 4)  if best_hr  is not None else None, 'n': len(got_best)},
        'got_worse_line': {'hit_rate': round(worse_hr, 4) if worse_hr is not None else None, 'n': len(got_worse)},
    }


def logreg_ceiling(grades, logs_by_player, def_stats_map):
    """
    Module 8 — Ceiling check via LogisticRegression.

    Builds the same factor vectors used in Module 2, fits a logistic regression
    with chronological train/val split, and reports val AUC. This is a ceiling
    estimate for what a *linear* combination of the current factors can achieve.

    If logreg AUC > current weighted-score AUC by >0.02, hand-tuning is leaving
    measurable alpha on the table and an automated retune (or a non-linear model)
    is worth investing in.
    """
    print("-- Module 8: LogReg Ceiling Check --------------------------------------")
    try:
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import roc_auc_score
    except ImportError:
        print("  scikit-learn not installed — skip. (pip install scikit-learn numpy)\n")
        return {'error': 'sklearn_not_installed'}

    # Sort grades chronologically so the val set is genuinely held out.
    grades_sorted = sorted(grades, key=lambda g: g.get('game_date', ''))

    cases = []
    for g in grades_sorted:
        player = g['player_name']
        stat = g['stat_type']
        try:
            line = float(g['line'])
        except (TypeError, ValueError):
            continue
        direction = g.get('direction', 'over')
        game_date = g['game_date']
        if g.get('hit') is None:
            continue
        hit = 1 if g['hit'] else 0

        if player not in logs_by_player:
            continue
        all_logs = sorted(logs_by_player[player], key=lambda l: l['game_date'])
        prior = list(reversed([l for l in all_logs if l['game_date'] < game_date]))
        if len(prior) < 10:
            continue
        target = next((l for l in all_logs if l['game_date'] == game_date), None)
        if not target:
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
        weighted_score = g.get('confidence_score')
        try:
            weighted_score = float(weighted_score) if weighted_score is not None else None
        except (TypeError, ValueError):
            weighted_score = None
        cases.append({'features': features, 'label': hit, 'weighted_score': weighted_score})

    if len(cases) < 200:
        print(f"  Only {len(cases)} matched cases — need 200+ for a meaningful split. Skipping.\n")
        return {'error': 'insufficient_data', 'matched': len(cases)}

    # Chronological 75/25 split (cases were built from grades_sorted).
    split = int(len(cases) * 0.75)
    train, val = cases[:split], cases[split:]
    X_train = np.array([c['features'] for c in train])
    y_train = np.array([c['label']    for c in train])
    X_val   = np.array([c['features'] for c in val])
    y_val   = np.array([c['label']    for c in val])

    if len(set(y_train.tolist())) < 2 or len(set(y_val.tolist())) < 2:
        print("  Train or val split lacks both classes — skipping.\n")
        return {'error': 'degenerate_split'}

    # Standardize features (already in 0–1) — fit logreg.
    clf = LogisticRegression(max_iter=2000, C=1.0)
    clf.fit(X_train, y_train)
    val_proba  = clf.predict_proba(X_val)[:, 1]
    logreg_auc = float(roc_auc_score(y_val, val_proba))

    # Compare against the current confidence_score from prop_grades on the same val set.
    weighted_pairs = [(c['weighted_score'], c['label']) for c in val if c['weighted_score'] is not None]
    if len(weighted_pairs) >= 30 and len(set(p[1] for p in weighted_pairs)) == 2:
        ws = np.array([p[0] for p in weighted_pairs])
        ys = np.array([p[1] for p in weighted_pairs])
        weighted_auc = float(roc_auc_score(ys, ws))
    else:
        weighted_auc = None

    coefs = dict(zip(FACTOR_NAMES, [round(float(c), 4) for c in clf.coef_[0]]))
    intercept = round(float(clf.intercept_[0]), 4)

    print(f"  Train cases: {len(train):,} | Val cases: {len(val):,}")
    print(f"  LogReg val AUC:           {logreg_auc:.4f}")
    if weighted_auc is not None:
        gap = logreg_auc - weighted_auc
        marker = '!! GAP' if gap > 0.02 else ''
        print(f"  Current weighted-score AUC: {weighted_auc:.4f} (n={len(weighted_pairs):,})")
        print(f"  Gap (logreg - weighted):    {gap:+.4f} {marker}")
        if gap > 0.02:
            print(f"  Recommendation: hand-weights are leaving alpha on the table.")
            print(f"                  Re-run auto_retrain or try a non-linear model.")
    else:
        print(f"  No comparable weighted-score AUC available (val too small or single-class).")
    print(f"  LogReg coefficients (val-fit):")
    for f, c in sorted(coefs.items(), key=lambda kv: -abs(kv[1])):
        print(f"    {f:<18} {c:>+7.4f}")
    print()

    return {
        'matched_cases': len(cases),
        'train_n': len(train),
        'val_n':   len(val),
        'logreg_auc':           round(logreg_auc, 4),
        'weighted_score_auc':   round(weighted_auc, 4) if weighted_auc is not None else None,
        'gap':                  round(logreg_auc - weighted_auc, 4) if weighted_auc is not None else None,
        'logreg_intercept': intercept,
        'logreg_coefs':     coefs,
    }


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
                recommendations.append(f"Factor '{f['factor']}' is anti-correlated -- consider reducing its weight or inverting")

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
        recommendations.append(f"Model accuracy is {direction} over time (delta {drift['delta']:+.1%})")

    # Print recommendations
    if recommendations:
        print(f"\n  Top recommendations:")
        for i, rec in enumerate(recommendations[:8], 1):
            print(f"    {i}. {rec}")
    else:
        print("\n  No major issues detected -- model looks well-calibrated.")

    report['recommendations'] = recommendations
    print()


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
    report['factor_calibration'] = factor_calibration(grades, logs_by_player, def_stats_map)
    report['over_under_asymmetry'] = over_under_asymmetry(grades)
    report['calibration_curve'] = calibration_curve(grades)
    report['high_confidence_misses'] = high_confidence_misses(grades)
    report['temporal'] = temporal_analysis(grades)
    report['line_dispersion'] = line_dispersion_analysis(grades)
    report['logreg_ceiling']  = logreg_ceiling(grades, logs_by_player, def_stats_map)

    print_summary(report)

    # ── Save report ──────────────────────────────────────────────────────────
    out_path = os.path.join(os.path.dirname(__file__), '..', 'diagnostic_report.json')
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved -> diagnostic_report.json")


if __name__ == '__main__':
    main()
