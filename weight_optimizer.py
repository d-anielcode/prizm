#!/usr/bin/env python3
"""
Prizm Weight Optimizer
======================
Finds the optimal weight combination for the confidence model by sampling random
weight vectors (Dirichlet distribution) and evaluating each against the full
real-prop backtest dataset.

Run:
    pip install supabase numpy
    python weight_optimizer.py

Two search modes:
  1. FULL  — all 11 weights free (shows what the model wants in log-only mode)
  2. FIXED — neutral backtest factors (matchupEdge, pace, injury, blowout,
             homeAway, vsOpponent) held at current weights; only optimizes the
             5 log-based active factors. Better reflects live model behavior.
"""

import json, re, sys, time
from datetime import datetime, timedelta

import numpy as np

# ── Supabase ─────────────────────────────────────────────────────────────────
SUPABASE_URL = "https://shvoyqofsbtnzwokuutt.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodm95cW9mc2J0bnp3b2t1dXR0Iiwicm9sZSI6"
    "InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzgxODY4MCwiZXhwIjoyMDg5Mzk0NjgwfQ."
    "2CS-wswMqFwesjH-O0C2Sgy3B7thyDxe5n-3iTaNE2s"
)

try:
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
except ImportError:
    print("Missing supabase library. Run:  pip install supabase")
    sys.exit(1)

# ── Config ────────────────────────────────────────────────────────────────────
N_FULL      = 5000    # random samples for full search
N_FIXED     = 8000    # random samples for fixed-neutral search (more iters, fewer dims)
MIN_HIGH    = 40      # minimum HIGH props required (avoids overfitting to tiny samples)
TOP_K       = 20      # how many results to display and save

WEIGHT_NAMES = [
    'lineValue', 'matchupEdge', 'last20HitRate', 'trend',
    'seasonCushion', 'pace', 'newsInjury', 'restDays',
    'blowout', 'homeAway', 'vsOpponent',
]
# Indices of ACTIVE (log-based) vs NEUTRAL (always 0.50 in backtest)
ACTIVE_IDX  = [0, 2, 3, 4, 7]   # lineValue, last20HitRate, trend, seasonCushion, restDays
NEUTRAL_IDX = [1, 5, 6, 8, 9, 10]  # matchupEdge, pace, newsInjury, blowout, homeAway, vsOpponent

# Current v5.4 weights
CURRENT_W = {
    'lineValue': 0.24, 'matchupEdge': 0.18, 'last20HitRate': 0.15, 'trend': 0.13,
    'seasonCushion': 0.07, 'pace': 0.06, 'newsInjury': 0.05, 'restDays': 0.05,
    'blowout': 0.04, 'homeAway': 0.02, 'vsOpponent': 0.01,
}
CURRENT_W_VEC = np.array([CURRENT_W[k] for k in WEIGHT_NAMES], dtype=np.float32)

# Neutral factor fixed weights (held constant in FIXED mode)
NEUTRAL_W_VEC = np.array([CURRENT_W[WEIGHT_NAMES[i]] for i in NEUTRAL_IDX], dtype=np.float32)

STAT_COLS = {
    'points': 'points', 'rebounds': 'rebounds', 'assists': 'assists',
    'pra': 'pra', 'blocks': 'blocks', 'steals': 'steals', 'three_pointers': 'fg3m',
}
HIGH_THRESH_BY_STAT = {'assists': 78, 'pra': 78, 'three_pointers': 76}


# ── Supabase data loader ──────────────────────────────────────────────────────
def load_table(table, select, extra_filters=None, order_col=None, order_asc=True):
    rows, page_size, start = [], 1000, 0
    while True:
        q = sb.from_(table).select(select)
        if extra_filters:
            for method, args in extra_filters:
                q = getattr(q, method)(*args)
        if order_col:
            q = q.order(order_col, desc=not order_asc)
        resp = q.range(start, start + page_size - 1).execute()
        page = resp.data or []
        rows.extend(page)
        if len(page) < page_size:
            break
        start += page_size
    return rows


# ── Scoring helpers (mirror confidence.ts logic) ─────────────────────────────
def clamp(x, lo=0.05, hi=0.95):
    return max(lo, min(hi, x))


def date_cutoff(commence_time, days_back):
    if not commence_time:
        return None
    try:
        dt = datetime.fromisoformat(commence_time.replace('Z', '+00:00'))
        return (dt - timedelta(days=days_back)).strftime('%Y-%m-%d')
    except Exception:
        return None


def stat_val(log, stat):
    return log.get(STAT_COLS.get(stat, stat), 0) or 0


def f_line_value(logs, stat, line, direction, ct):
    cutoff = date_cutoff(ct, 60)
    eligible = [g for g in logs if g['game_date'] >= cutoff] if cutoff else logs
    recent = [stat_val(g, stat) for g in eligible[:10] if stat_val(g, stat) >= 0]
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
        return None
    wh = tw = 0.0
    for i, g in enumerate(sl):
        w = 0.93 ** i
        hit = stat_val(g, stat) > line if direction == 'over' else stat_val(g, stat) < line
        wh += w if hit else 0
        tw += w
    return wh / tw if tw else 0.5


def f_trend(logs, stat, direction, ct):
    cutoff = date_cutoff(ct, 90)
    el = ([g for g in logs if g['game_date'] >= cutoff] if cutoff else logs)
    l5  = [stat_val(g, stat) for g in el[:5]]
    l20 = [stat_val(g, stat) for g in el[:20]]
    if len(l5) < 3 or len(l20) < 8:
        return 0.5
    a5, a20 = sum(l5) / len(l5), sum(l20) / len(l20)
    if a20 == 0:
        return 0.5
    raw = clamp((a5 - a20) / a20 / 0.40 + 0.50)
    return raw if direction == 'over' else 1 - raw


def f_cushion(logs, stat, line, direction):
    vals = [stat_val(g, stat) for g in logs if stat_val(g, stat) >= 0]
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
    # 1. Load real OVER props
    print("Loading historical_prop_lines (OVER only)...")
    props = load_table(
        'historical_prop_lines',
        'player_name,stat_type,direction,line,game_date,commence_time',
        extra_filters=[('eq', ('direction', 'over'))],
    )
    print(f"  {len(props)} props loaded")

    # 2. Load game logs for all relevant players
    players = list({p['player_name'] for p in props})
    print(f"Loading game logs for {len(players)} players (paginated)...")
    all_logs = []
    BATCH = 100
    PAGE  = 1000
    for i in range(0, len(players), BATCH):
        batch = players[i:i + BATCH]
        start = 0
        while True:
            resp = (
                sb.from_('player_game_logs')
                .select('player_name,game_date,matchup,is_home,points,rebounds,assists,pra,blocks,steals,fg3m,minutes')
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
        print(f"  {min(i + BATCH, len(players))}/{len(players)} players, {len(all_logs)} logs so far...", end='\r', flush=True)
    print(f"\n  {len(all_logs)} log rows loaded")

    # Index logs
    logs_by_player: dict[str, list] = {}
    for log in all_logs:
        logs_by_player.setdefault(log['player_name'], []).append(log)

    actual_by: dict[str, dict] = {}
    for log in all_logs:
        actual_by[f"{log['player_name']}|{log['game_date']}"] = log

    # 3. Precompute all factors once
    print("Precomputing factor scores...")
    rows_factors   = []
    rows_freshness = []
    rows_consensus = []
    rows_star      = []
    rows_hit       = []
    rows_thresh    = []
    skipped = 0

    for prop in props:
        pn   = prop['player_name']
        stat = prop['stat_type']
        if stat not in STAT_COLS:
            skipped += 1
            continue

        actual = actual_by.get(f"{pn}|{prop['game_date']}")
        if actual is None:
            skipped += 1
            continue

        all_pl = logs_by_player.get(pn, [])
        prior  = [g for g in all_pl if g['game_date'] < prop['game_date']]
        if len(prior) < 3:
            skipped += 1
            continue

        dir_   = prop['direction']
        line   = prop['line']
        ct     = prop.get('commence_time') or f"{prop['game_date']}T23:30:00+00:00"

        # Active factors
        lv   = f_line_value(prior, stat, line, dir_, ct)
        hr20 = f_hit_rate(prior, stat, line, dir_, 20, ct)
        if hr20 is None: hr20 = 0.5
        tr   = f_trend(prior, stat, dir_, ct)
        cu   = f_cushion(prior, stat, line, dir_)
        rst  = f_rest(prior, ct)

        # Neutral factors (always 0.50 in backtest — no live context passed)
        mtch = 0.50
        pace = 0.50
        inj  = 0.50
        blot = 0.50
        ha   = 0.50
        vs   = 0.50

        fresh = f_freshness(prior, ct)

        # Consensus (based on factor scores, not weights — fixed per prop)
        primary = [lv, mtch, hr20, tr, cu]
        agree   = sum(1 for f in primary if f >= 0.55)
        cons    = 3 if agree >= 4 else (0 if agree >= 3 else (-4 if agree >= 2 else -10))

        # Star bonus (fixed per prop)
        avg_mins = sum(g.get('minutes') or 0 for g in prior[:10]) / min(10, len(prior))
        star = 3 if (avg_mins >= 36 and lv >= 0.58 and hr20 >= 0.55) else 0

        # Actual result
        col = STAT_COLS[stat]
        hit = (actual.get(col) or 0) > line

        thresh = HIGH_THRESH_BY_STAT.get(stat, 70)

        rows_factors.append([lv, mtch, hr20, tr, cu, pace, inj, rst, blot, ha, vs])
        rows_freshness.append(fresh)
        rows_consensus.append(cons)
        rows_star.append(star)
        rows_hit.append(hit)
        rows_thresh.append(thresh)

    n = len(rows_factors)
    print(f"  {n} props ready, {skipped} skipped")

    F         = np.array(rows_factors,   dtype=np.float32)   # (M, 11)
    FRESH     = np.array(rows_freshness, dtype=np.float32)   # (M,)
    CONS      = np.array(rows_consensus, dtype=np.float32)   # (M,)
    STAR      = np.array(rows_star,      dtype=np.float32)   # (M,)
    HITS      = np.array(rows_hit,       dtype=bool)         # (M,)
    THRESH    = np.array(rows_thresh,    dtype=np.float32)   # (M,)

    def evaluate(w_vec):
        raw = F @ w_vec
        adj = 0.5 + (raw - 0.5) * FRESH
        score = np.clip(adj * 100 + CONS * FRESH + STAR, 18, 95)
        is_high = score >= THRESH
        hc = int(is_high.sum())
        if hc < MIN_HIGH:
            return None
        hh = int(HITS[is_high].sum())
        return {'hit_rate': hh / hc, 'high_count': hc, 'high_hits': hh,
                'weights': {k: round(float(v), 4) for k, v in zip(WEIGHT_NAMES, w_vec)}}

    # Baseline: current v5.4
    baseline = evaluate(CURRENT_W_VEC)
    if baseline:
        print(f"\nBaseline v5.4: {baseline['high_count']} HIGH props, "
              f"{baseline['hit_rate']*100:.1f}% hit rate")

    # ── Search 1: FULL — all 11 weights free ─────────────────────────────────
    print(f"\n[FULL SEARCH] {N_FULL} iterations, all 11 weights free...")
    t0 = time.time()
    full_results = []
    for i in range(N_FULL):
        w = np.random.dirichlet(np.ones(11)).astype(np.float32)
        r = evaluate(w)
        if r:
            full_results.append(r)
        if (i + 1) % 1000 == 0:
            print(f"  {i+1}/{N_FULL}...", end='\r', flush=True)
    full_results.sort(key=lambda r: (r['hit_rate'], r['high_count']), reverse=True)
    print(f"\n  Done in {time.time()-t0:.1f}s. {len(full_results)} valid results.")

    # ── Search 2: FIXED — neutral factors at current weights, optimize 5 active ─
    print(f"\n[FIXED SEARCH] {N_FIXED} iterations, neutral factors fixed at v5.4 weights...")
    neutral_sum = float(NEUTRAL_W_VEC.sum())   # weight reserved for neutral factors
    active_budget = 1.0 - neutral_sum

    t0 = time.time()
    fixed_results = []
    for i in range(N_FIXED):
        # Sample 5 active weights that sum to active_budget
        active_w = np.random.dirichlet(np.ones(5)).astype(np.float32) * active_budget
        w = np.zeros(11, dtype=np.float32)
        for j, ai in enumerate(ACTIVE_IDX):
            w[ai] = active_w[j]
        for j, ni in enumerate(NEUTRAL_IDX):
            w[ni] = NEUTRAL_W_VEC[j]
        r = evaluate(w)
        if r:
            fixed_results.append(r)
        if (i + 1) % 1000 == 0:
            print(f"  {i+1}/{N_FIXED}...", end='\r', flush=True)
    fixed_results.sort(key=lambda r: (r['hit_rate'], r['high_count']), reverse=True)
    print(f"\n  Done in {time.time()-t0:.1f}s. {len(fixed_results)} valid results.")

    # ── Print results ─────────────────────────────────────────────────────────
    def print_results(label, results, top_n=10):
        print(f"\n{'='*65}")
        print(f"  {label}  —  TOP {top_n} (min {MIN_HIGH} HIGH props)")
        print(f"{'='*65}")
        for rank, r in enumerate(results[:top_n], 1):
            w = r['weights']
            print(f"\n#{rank}  {r['hit_rate']*100:.1f}%  ({r['high_hits']}/{r['high_count']} HIGH)")
            print(f"  lineVal={w['lineValue']:.3f}  matchup={w['matchupEdge']:.3f}  "
                  f"hitRate={w['last20HitRate']:.3f}  trend={w['trend']:.3f}")
            print(f"  cushion={w['seasonCushion']:.3f}  pace={w['pace']:.3f}  "
                  f"injury={w['newsInjury']:.3f}  rest={w['restDays']:.3f}")
            print(f"  blowout={w['blowout']:.3f}  home={w['homeAway']:.3f}  "
                  f"vsOpp={w['vsOpponent']:.3f}")

    print_results("FULL SEARCH (all 11 free)", full_results)
    print_results("FIXED SEARCH (active factors only)", fixed_results)

    if baseline:
        b = baseline
        print(f"\n--- Baseline v5.4: {b['hit_rate']*100:.1f}% ({b['high_hits']}/{b['high_count']}) ---")

    # ── Aggregate: average weights of top-50 full results ────────────────────
    top50_full = full_results[:50]
    if top50_full:
        avg_w = {k: round(sum(r['weights'][k] for r in top50_full) / len(top50_full), 4)
                 for k in WEIGHT_NAMES}
        print(f"\n{'='*65}")
        print("  AVERAGE WEIGHTS OF TOP-50 FULL RESULTS  (aggregate signal)")
        print(f"{'='*65}")
        print("  " + "  ".join(f"{k}={v}" for k, v in avg_w.items()))
        avg_w_vec = np.array([avg_w[k] for k in WEIGHT_NAMES], dtype=np.float32)
        avg_w_vec /= avg_w_vec.sum()  # renormalize just in case
        agg = evaluate(avg_w_vec)
        if agg:
            print(f"  -> If applied: {agg['hit_rate']*100:.1f}% ({agg['high_hits']}/{agg['high_count']} HIGH)")

    # ── Save ──────────────────────────────────────────────────────────────────
    output = {
        'generated_at':   datetime.now().isoformat(),
        'n_props':        n,
        'n_skipped':      skipped,
        'min_high_count': MIN_HIGH,
        'baseline_v54':   baseline,
        'full_search': {
            'n_iterations': N_FULL,
            'n_valid':      len(full_results),
            'top_results':  full_results[:TOP_K],
        },
        'fixed_search': {
            'n_iterations':      N_FIXED,
            'n_valid':           len(fixed_results),
            'neutral_weights':   {WEIGHT_NAMES[i]: float(NEUTRAL_W_VEC[j]) for j, i in enumerate(NEUTRAL_IDX)},
            'active_budget':     round(active_budget, 4),
            'top_results':       fixed_results[:TOP_K],
        },
        'top50_avg_weights': avg_w if top50_full else None,
    }
    out_path = 'weight_optimizer_results.json'
    with open(out_path, 'w') as fh:
        json.dump(output, fh, indent=2)
    print(f"\nSaved to {out_path}")


if __name__ == '__main__':
    main()
