#!/usr/bin/env python3
"""
Prizm Per-Stat Weight Optimizer
================================
Finds the optimal weight vector for each stat type independently by sampling
random Dirichlet weight vectors and evaluating hit rate at HIGH-confidence props.

Run:
    pip install supabase numpy
    python weight_optimizer.py [--stat points]

Output:
  - Per-stat: top-10 weight vectors ranked by hit rate at HIGH threshold
  - Per-stat: average weights of top-50 vectors (aggregate signal)
  - Baseline hit rate for each stat using current confidence.ts weights
  - Saved to weight_optimizer_results.json
"""

import json, sys, time, argparse
from datetime import datetime, timedelta

import numpy as np

# ── Supabase ─────────────────────────────────────────────────────────────────
import os

env = {}
ENV_PATH = os.path.join(os.path.dirname(__file__), '.env.local')
try:
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
except FileNotFoundError:
    pass

SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local")
    sys.exit(1)

try:
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
except ImportError:
    print("Missing supabase library. Run:  pip install supabase")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
N_ITER     = 10_000   # random samples per stat
MIN_HIGH   = 30       # minimum HIGH props required (avoid overfitting tiny samples)
TOP_K      = 20       # results to save per stat

WEIGHT_NAMES = [
    'lineValue', 'matchupEdge', 'last20HitRate', 'trend',
    'seasonCushion', 'pace', 'newsInjury', 'restDays',
    'blowout', 'homeAway', 'vsOpponent',
]

STAT_COLS = {
    'points':        'points',
    'rebounds':      'rebounds',
    'assists':       'assists',
    'pra':           'pra',
    'blocks':        'blocks',
    'steals':        'steals',
    'three_pointers': 'fg3m',
}

# HIGH-confidence threshold per stat (mirrors confidence.ts getLabel + ALT_LOCK_T)
HIGH_THRESH = {
    'points':        68,
    'rebounds':      68,
    'assists':       74,
    'pra':           78,
    'blocks':        72,
    'steals':        72,
    'three_pointers': 72,
}

# Current weights from confidence.ts (for baseline comparison)
CURRENT_WEIGHTS = {
    'points': {
        'lineValue': 0.04, 'matchupEdge': 0.14, 'last20HitRate': 0.20, 'trend': 0.14,
        'seasonCushion': 0.02, 'pace': 0.06, 'newsInjury': 0.09, 'restDays': 0.05,
        'blowout': 0.12, 'homeAway': 0.10, 'vsOpponent': 0.04,
    },
    'rebounds': {
        'lineValue': 0.04, 'matchupEdge': 0.22, 'last20HitRate': 0.16, 'trend': 0.08,
        'seasonCushion': 0.04, 'pace': 0.10, 'newsInjury': 0.10, 'restDays': 0.05,
        'blowout': 0.06, 'homeAway': 0.07, 'vsOpponent': 0.08,
    },
    'assists': {
        'lineValue': 0.04, 'matchupEdge': 0.18, 'last20HitRate': 0.16, 'trend': 0.10,
        'seasonCushion': 0.04, 'pace': 0.08, 'newsInjury': 0.10, 'restDays': 0.05,
        'blowout': 0.08, 'homeAway': 0.09, 'vsOpponent': 0.08,
    },
    'pra': {
        'lineValue': 0.06, 'matchupEdge': 0.14, 'last20HitRate': 0.18, 'trend': 0.14,
        'seasonCushion': 0.06, 'pace': 0.06, 'newsInjury': 0.09, 'restDays': 0.05,
        'blowout': 0.10, 'homeAway': 0.08, 'vsOpponent': 0.04,
    },
    'steals': {
        'lineValue': 0.06, 'matchupEdge': 0.20, 'last20HitRate': 0.10, 'trend': 0.08,
        'seasonCushion': 0.04, 'pace': 0.03, 'newsInjury': 0.10, 'restDays': 0.05,
        'blowout': 0.08, 'homeAway': 0.10, 'vsOpponent': 0.16,
    },
    'blocks': {
        'lineValue': 0.06, 'matchupEdge': 0.20, 'last20HitRate': 0.10, 'trend': 0.08,
        'seasonCushion': 0.04, 'pace': 0.03, 'newsInjury': 0.10, 'restDays': 0.05,
        'blowout': 0.08, 'homeAway': 0.10, 'vsOpponent': 0.16,
    },
    'three_pointers': {
        'lineValue': 0.04, 'matchupEdge': 0.16, 'last20HitRate': 0.14, 'trend': 0.14,
        'seasonCushion': 0.04, 'pace': 0.10, 'newsInjury': 0.08, 'restDays': 0.05,
        'blowout': 0.09, 'homeAway': 0.12, 'vsOpponent': 0.04,
    },
}

# ── Supabase loader ────────────────────────────────────────────────────────────
def load_table(table, select, filters=None):
    rows, start = [], 0
    while True:
        q = sb.from_(table).select(select)
        for method, args in (filters or []):
            q = getattr(q, method)(*args)
        resp = q.range(start, start + 999).execute()
        page = resp.data or []
        rows.extend(page)
        if len(page) < 1000:
            break
        start += 1000
    return rows


# ── Scoring helpers (mirror confidence.ts) ────────────────────────────────────
def clamp(x, lo=0.05, hi=0.95):
    return max(lo, min(hi, x))


def date_cutoff(ct, days_back):
    if not ct:
        return None
    try:
        dt = datetime.fromisoformat(ct.replace('Z', '+00:00'))
        return (dt - timedelta(days=days_back)).strftime('%Y-%m-%d')
    except Exception:
        return None


def sv(log, stat):
    col = STAT_COLS.get(stat, stat)
    return log.get(col) or 0


def f_line_value(logs, stat, line, direction, ct):
    cutoff = date_cutoff(ct, 60)
    eligible = [g for g in logs if g['game_date'] >= cutoff] if cutoff else logs
    recent = [sv(g, stat) for g in eligible[:10]]
    if len(recent) < 5:
        return 0.5
    mean = sum(recent) / len(recent)
    stdev = (sum((v - mean) ** 2 for v in recent) / len(recent)) ** 0.5
    if stdev < 0.5:
        return 0.5
    z = (mean - line) / stdev if direction == 'over' else (line - mean) / stdev
    return clamp(0.5 + z * 0.28)


def f_hit_rate(logs, stat, line, direction, n, ct):
    cutoff = date_cutoff(ct, 90)
    sl = ([g for g in logs if g['game_date'] >= cutoff] if cutoff else logs)[:n]
    if len(sl) < 3:
        return 0.5
    wh = tw = 0.0
    for i, g in enumerate(sl):
        w = 0.93 ** i
        hit = sv(g, stat) > line if direction == 'over' else sv(g, stat) < line
        wh += w if hit else 0
        tw += w
    return wh / tw if tw else 0.5


def f_trend(logs, stat, direction, ct):
    cutoff = date_cutoff(ct, 90)
    el = ([g for g in logs if g['game_date'] >= cutoff] if cutoff else logs)
    l5  = [sv(g, stat) for g in el[:5]]
    l20 = [sv(g, stat) for g in el[:20]]
    if len(l5) < 3 or len(l20) < 8:
        return 0.5
    a5, a20 = sum(l5) / len(l5), sum(l20) / len(l20)
    if a20 == 0:
        return 0.5
    raw = clamp((a5 - a20) / a20 / 0.40 + 0.50)
    return raw if direction == 'over' else 1 - raw


def f_cushion(logs, stat, line, direction):
    vals = [sv(g, stat) for g in logs]
    if len(vals) < 5:
        return 0.5
    avg = sum(vals) / len(vals)
    raw = clamp((avg - line) / max(line, 1) / 0.60 + 0.50)
    return raw if direction == 'over' else 1 - raw


def f_rest(logs, ct):
    if not logs or not ct:
        return 0.5
    try:
        last = datetime.fromisoformat(logs[0]['game_date'])
        tonight = datetime.fromisoformat(ct[:10])
        rest = round((tonight - last).days) - 1
        if rest <= 0: return 0.25
        if rest == 1: return 0.50
        if rest == 2: return 0.60
        return 0.55
    except Exception:
        return 0.5


def f_freshness(logs, ct):
    if not logs or not ct:
        return 0.7
    try:
        last = datetime.fromisoformat(logs[0]['game_date'])
        tonight = datetime.fromisoformat(ct[:10])
        gap = (tonight - last).days
        if gap > 90: return 0.15
        if gap > 45: return 0.35
        if gap > 21: return 0.55
        if gap > 14: return 0.72
        if gap > 7:  return 0.88
        return 1.0
    except Exception:
        return 1.0


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stat', default=None, help='Optimize only this stat type')
    parser.add_argument('--iters', type=int, default=N_ITER)
    args = parser.parse_args()

    target_stats = [args.stat] if args.stat else list(STAT_COLS.keys())

    # ── Load all OVER props from historical_prop_lines ──────────────────────
    print("Loading historical_prop_lines (OVER only)...")
    props = load_table(
        'historical_prop_lines',
        'player_name,stat_type,direction,line,game_date,commence_time',
        filters=[('eq', ('direction', 'over'))],
    )
    print(f"  {len(props)} props loaded")

    # ── Load game logs ───────────────────────────────────────────────────────
    players = list({p['player_name'] for p in props})
    print(f"Loading game logs for {len(players)} players...")
    all_logs = []
    BATCH, PAGE = 100, 1000
    for i in range(0, len(players), BATCH):
        batch = players[i:i + BATCH]
        start = 0
        while True:
            resp = (
                sb.from_('player_game_logs')
                .select('player_name,game_date,points,rebounds,assists,pra,blocks,steals,fg3m,minutes')
                .in_('player_name', batch)
                .order('game_date', desc=True)
                .range(start, start + PAGE - 1)
                .execute()
            )
            page = resp.data or []
            all_logs.extend(page)
            if len(page) < PAGE:
                break
            start += PAGE
        print(f"  {min(i+BATCH, len(players))}/{len(players)} players, {len(all_logs)} logs...", end='\r', flush=True)
    print(f"\n  {len(all_logs)} log rows loaded")

    logs_by_player: dict[str, list] = {}
    for log in all_logs:
        logs_by_player.setdefault(log['player_name'], []).append(log)

    actual_by: dict[str, dict] = {}
    for log in all_logs:
        actual_by[f"{log['player_name']}|{log['game_date']}"] = log

    # ── Per-stat optimization ─────────────────────────────────────────────────
    all_results = {}

    for stat in target_stats:
        thresh = HIGH_THRESH.get(stat, 68)
        stat_props = [p for p in props if p['stat_type'] == stat]
        print(f"\n{'='*60}")
        print(f"  {stat.upper()} — {len(stat_props)} props, HIGH threshold={thresh}")

        # Precompute factors for this stat
        F_rows, FRESH_rows, CONS_rows, STAR_rows, HITS_rows = [], [], [], [], []
        skipped = 0

        for prop in stat_props:
            pn   = prop['player_name']
            line = float(prop['line'])
            ct   = prop.get('commence_time') or f"{prop['game_date']}T23:30:00+00:00"

            actual = actual_by.get(f"{pn}|{prop['game_date']}")
            if actual is None:
                skipped += 1
                continue

            all_pl = logs_by_player.get(pn, [])
            prior  = [g for g in all_pl if g['game_date'] < prop['game_date']]
            if len(prior) < 3:
                skipped += 1
                continue

            lv   = f_line_value(prior, stat, line, 'over', ct)
            hr20 = f_hit_rate(prior, stat, line, 'over', 20, ct)
            tr   = f_trend(prior, stat, 'over', ct)
            cu   = f_cushion(prior, stat, line, 'over')
            rst  = f_rest(prior, ct)
            # Neutral factors held at 0.50 (no live matchup/injury data in backtest)
            mtch = pace = inj = blot = ha = vs = 0.50

            fresh = f_freshness(prior, ct)
            primary = [lv, mtch, hr20, tr, cu]
            agree   = sum(1 for f in primary if f >= 0.55)
            cons    = 3 if agree >= 4 else (0 if agree >= 3 else (-4 if agree >= 2 else -10))
            avg_mins = sum(g.get('minutes') or 0 for g in prior[:10]) / min(10, len(prior))
            star = 3 if (avg_mins >= 36 and lv >= 0.58 and hr20 >= 0.55) else 0

            col = STAT_COLS[stat]
            hit = (actual.get(col) or 0) > line

            F_rows.append([lv, mtch, hr20, tr, cu, pace, inj, rst, blot, ha, vs])
            FRESH_rows.append(fresh)
            CONS_rows.append(cons)
            STAR_rows.append(star)
            HITS_rows.append(hit)

        n = len(F_rows)
        print(f"  {n} props ready, {skipped} skipped")
        if n < MIN_HIGH * 2:
            print(f"  Skipping — too few props")
            continue

        F     = np.array(F_rows,    dtype=np.float32)
        FRESH = np.array(FRESH_rows, dtype=np.float32)
        CONS  = np.array(CONS_rows,  dtype=np.float32)
        STAR  = np.array(STAR_rows,  dtype=np.float32)
        HITS  = np.array(HITS_rows,  dtype=bool)

        def evaluate(w_vec):
            raw = F @ w_vec
            adj = 0.5 + (raw - 0.5) * FRESH
            score = np.clip(adj * 100 + CONS * FRESH + STAR, 18, 95)
            is_high = score >= thresh
            hc = int(is_high.sum())
            if hc < MIN_HIGH:
                return None
            hh = int(HITS[is_high].sum())
            return {
                'hit_rate':   hh / hc,
                'high_count': hc,
                'high_hits':  hh,
                'weights':    {k: round(float(v), 4) for k, v in zip(WEIGHT_NAMES, w_vec)},
            }

        # Baseline with current weights
        cw = CURRENT_WEIGHTS.get(stat, CURRENT_WEIGHTS['points'])
        cw_vec = np.array([cw[k] for k in WEIGHT_NAMES], dtype=np.float32)
        baseline = evaluate(cw_vec)
        if baseline:
            print(f"  Baseline: {baseline['hit_rate']*100:.1f}%  ({baseline['high_hits']}/{baseline['high_count']} HIGH)")

        # Random search
        print(f"  Running {args.iters} iterations...")
        t0 = time.time()
        results = []
        for i in range(args.iters):
            w = np.random.dirichlet(np.ones(11)).astype(np.float32)
            r = evaluate(w)
            if r:
                results.append(r)
            if (i + 1) % 2000 == 0:
                print(f"    {i+1}/{args.iters}...", end='\r', flush=True)

        results.sort(key=lambda r: (r['hit_rate'], r['high_count']), reverse=True)
        print(f"\n  Done in {time.time()-t0:.1f}s — {len(results)} valid results")

        # Top-10 summary
        print(f"\n  TOP 10 ({stat}):")
        for rank, r in enumerate(results[:10], 1):
            w = r['weights']
            print(f"  #{rank}  {r['hit_rate']*100:.1f}%  ({r['high_hits']}/{r['high_count']})")
            print(f"     lv={w['lineValue']:.3f}  mtch={w['matchupEdge']:.3f}  "
                  f"hr={w['last20HitRate']:.3f}  tr={w['trend']:.3f}  "
                  f"cu={w['seasonCushion']:.3f}  pace={w['pace']:.3f}")
            print(f"     inj={w['newsInjury']:.3f}  rest={w['restDays']:.3f}  "
                  f"blot={w['blowout']:.3f}  home={w['homeAway']:.3f}  "
                  f"vs={w['vsOpponent']:.3f}")

        # Average of top-50 (aggregate signal — more stable than single best)
        top50 = results[:50]
        avg_w = None
        if top50:
            avg_w = {k: round(sum(r['weights'][k] for r in top50) / len(top50), 4)
                     for k in WEIGHT_NAMES}
            avg_vec = np.array([avg_w[k] for k in WEIGHT_NAMES], dtype=np.float32)
            avg_vec /= avg_vec.sum()
            agg = evaluate(avg_vec)
            if agg:
                print(f"\n  Top-50 avg weights -> {agg['hit_rate']*100:.1f}%  ({agg['high_hits']}/{agg['high_count']})")
                print(f"  " + "  ".join(f"{k}={round(float(avg_vec[i]),4)}" for i, k in enumerate(WEIGHT_NAMES)))

        all_results[stat] = {
            'n_props':       n,
            'n_skipped':     skipped,
            'high_threshold': thresh,
            'baseline':      baseline,
            'top_results':   results[:TOP_K],
            'top50_avg_weights': avg_w,
        }

    # ── Save ──────────────────────────────────────────────────────────────────
    output = {
        'generated_at': datetime.now().isoformat(),
        'n_iterations': args.iters,
        'min_high_count': MIN_HIGH,
        'results_by_stat': all_results,
    }
    out_path = 'weight_optimizer_results.json'
    with open(out_path, 'w') as fh:
        json.dump(output, fh, indent=2)
    print(f"\nSaved to {out_path}")

    # ── Final summary across all stats ────────────────────────────────────────
    print(f"\n{'='*60}")
    print("  SUMMARY — Baseline vs Optimizer Top-50 Avg")
    print(f"{'='*60}")
    for stat, res in all_results.items():
        b  = res['baseline']
        t50 = res['top50_avg_weights']
        b_str  = f"{b['hit_rate']*100:.1f}% ({b['high_hits']}/{b['high_count']})" if b else "n/a"
        print(f"  {stat:<15} baseline={b_str}")
        if res['top_results']:
            best = res['top_results'][0]
            print(f"               best=   {best['hit_rate']*100:.1f}% ({best['high_hits']}/{best['high_count']})")


if __name__ == '__main__':
    main()
