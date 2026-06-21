#!/usr/bin/env python3
"""
Prizm Model Accuracy Comparison
=================================
Compares old weight sets (universal W + W_VOLATILE + W_THREE_POINTERS) against
the new per-stat optimized weight sets on the same historical prop data.

Metrics reported per stat and overall:
  - Directional accuracy: when model scores >= threshold, does the prop hit?
  - HIGH-confidence accuracy at each stat's threshold
  - Calibration by score bucket (50-59, 60-69, 70-79, 80+)
  - Overall directional accuracy (score > 50 -> predict hit)

Run:
    py -3.13 scripts/compare_weights.py
"""

import os, sys, json
from datetime import datetime, timedelta
from collections import defaultdict

# -- Load .env.local ------------------------------------------------------------
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

SUPABASE_URL = os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local")
    sys.exit(1)

try:
    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
except ImportError:
    print("Missing supabase. Run: pip install supabase")
    sys.exit(1)

import numpy as np

# -- Weight sets ----------------------------------------------------------------
WEIGHT_NAMES = [
    'lineValue', 'matchupEdge', 'last20HitRate', 'trend',
    'seasonCushion', 'pace', 'newsInjury', 'restDays',
    'blowout', 'homeAway', 'vsOpponent',
]

# Old weights (before this session's optimization)
OLD_WEIGHTS = {
    'points':        dict(lineValue=0.02, matchupEdge=0.14, last20HitRate=0.18, trend=0.12, seasonCushion=0.02, pace=0.05, newsInjury=0.09, restDays=0.05, blowout=0.11, homeAway=0.18, vsOpponent=0.04),
    'rebounds':      dict(lineValue=0.02, matchupEdge=0.14, last20HitRate=0.18, trend=0.12, seasonCushion=0.02, pace=0.05, newsInjury=0.09, restDays=0.05, blowout=0.11, homeAway=0.18, vsOpponent=0.04),
    'assists':       dict(lineValue=0.02, matchupEdge=0.14, last20HitRate=0.18, trend=0.12, seasonCushion=0.02, pace=0.05, newsInjury=0.09, restDays=0.05, blowout=0.11, homeAway=0.18, vsOpponent=0.04),
    'pra':           dict(lineValue=0.02, matchupEdge=0.14, last20HitRate=0.18, trend=0.12, seasonCushion=0.02, pace=0.05, newsInjury=0.09, restDays=0.05, blowout=0.11, homeAway=0.18, vsOpponent=0.04),
    'steals':        dict(lineValue=0.06, matchupEdge=0.20, last20HitRate=0.10, trend=0.08, seasonCushion=0.04, pace=0.03, newsInjury=0.10, restDays=0.05, blowout=0.08, homeAway=0.10, vsOpponent=0.16),
    'blocks':        dict(lineValue=0.06, matchupEdge=0.20, last20HitRate=0.10, trend=0.08, seasonCushion=0.04, pace=0.03, newsInjury=0.10, restDays=0.05, blowout=0.08, homeAway=0.10, vsOpponent=0.16),
    'three_pointers':dict(lineValue=0.04, matchupEdge=0.16, last20HitRate=0.14, trend=0.14, seasonCushion=0.04, pace=0.10, newsInjury=0.08, restDays=0.05, blowout=0.09, homeAway=0.12, vsOpponent=0.04),
}

# New per-stat optimized weights (from confidence.ts as of this session)
NEW_WEIGHTS = {
    'points':        dict(lineValue=0.04, matchupEdge=0.12, last20HitRate=0.22, trend=0.07, seasonCushion=0.05, pace=0.05, newsInjury=0.08, restDays=0.14, blowout=0.10, homeAway=0.09, vsOpponent=0.04),
    'rebounds':      dict(lineValue=0.06, matchupEdge=0.16, last20HitRate=0.10, trend=0.15, seasonCushion=0.09, pace=0.09, newsInjury=0.08, restDays=0.08, blowout=0.06, homeAway=0.07, vsOpponent=0.06),
    'assists':       dict(lineValue=0.10, matchupEdge=0.10, last20HitRate=0.07, trend=0.18, seasonCushion=0.20, pace=0.07, newsInjury=0.08, restDays=0.07, blowout=0.07, homeAway=0.05, vsOpponent=0.01),
    'pra':           dict(lineValue=0.08, matchupEdge=0.10, last20HitRate=0.08, trend=0.08, seasonCushion=0.30, pace=0.05, newsInjury=0.08, restDays=0.06, blowout=0.08, homeAway=0.06, vsOpponent=0.03),
    'steals':        dict(lineValue=0.13, matchupEdge=0.16, last20HitRate=0.13, trend=0.22, seasonCushion=0.08, pace=0.04, newsInjury=0.07, restDays=0.06, blowout=0.05, homeAway=0.05, vsOpponent=0.01),
    'blocks':        dict(lineValue=0.06, matchupEdge=0.14, last20HitRate=0.09, trend=0.18, seasonCushion=0.26, pace=0.05, newsInjury=0.08, restDays=0.04, blowout=0.07, homeAway=0.07, vsOpponent=0.06),
    'three_pointers':dict(lineValue=0.06, matchupEdge=0.12, last20HitRate=0.26, trend=0.15, seasonCushion=0.10, pace=0.08, newsInjury=0.06, restDays=0.07, blowout=0.05, homeAway=0.05, vsOpponent=0.00),
}

HIGH_THRESH = {
    'points': 68, 'rebounds': 68, 'assists': 74, 'pra': 78,
    'blocks': 72, 'steals': 72, 'three_pointers': 72,
}

STAT_COLS = {
    'points': 'points', 'rebounds': 'rebounds', 'assists': 'assists',
    'pra': 'pra', 'blocks': 'blocks', 'steals': 'steals', 'three_pointers': 'fg3m',
}

# -- Data loaders ---------------------------------------------------------------
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

# -- Scoring helpers ------------------------------------------------------------
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
    return log.get(STAT_COLS.get(stat, stat)) or 0

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
    a5, a20 = sum(l5)/len(l5), sum(l20)/len(l20)
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

def score_prop(factors, freshness, consensus, star, weights):
    """Compute confidence score given precomputed factors and a weight dict."""
    w = np.array([weights[k] for k in WEIGHT_NAMES], dtype=np.float32)
    raw = float(np.dot(factors, w))
    adj = 0.5 + (raw - 0.5) * freshness
    return max(18, min(95, adj * 100 + consensus * freshness + star))

# -- Main -----------------------------------------------------------------------
def main():
    print("Loading historical_prop_lines (OVER only)...")
    props = load_table(
        'historical_prop_lines',
        'player_name,stat_type,direction,line,game_date,commence_time',
        filters=[('eq', ('direction', 'over'))],
    )
    print(f"  {len(props)} props loaded")

    players = list({p['player_name'] for p in props})
    print(f"Loading game logs for {len(players)} players...")
    all_logs = []
    BATCH, PAGE = 100, 1000
    for i in range(0, len(players), BATCH):
        batch = players[i:i+BATCH]
        start = 0
        while True:
            resp = (sb.from_('player_game_logs')
                .select('player_name,game_date,points,rebounds,assists,pra,blocks,steals,fg3m,minutes')
                .in_('player_name', batch)
                .order('game_date', desc=True)
                .range(start, start+PAGE-1).execute())
            page = resp.data or []
            all_logs.extend(page)
            if len(page) < PAGE:
                break
            start += PAGE
        print(f"  {min(i+BATCH, len(players))}/{len(players)} players...", end='\r', flush=True)
    print(f"\n  {len(all_logs)} log rows")

    logs_by_player = defaultdict(list)
    for log in all_logs:
        logs_by_player[log['player_name']].append(log)
    actual_by = {f"{l['player_name']}|{l['game_date']}": l for l in all_logs}

    # Precompute factors for every prop
    print("Precomputing factors...")
    records = []   # {stat, factors, freshness, consensus, star, hit}
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

        line = float(prop['line'])
        ct   = prop.get('commence_time') or f"{prop['game_date']}T23:30:00+00:00"

        lv   = f_line_value(prior, stat, line, 'over', ct)
        hr20 = f_hit_rate(prior, stat, line, 'over', 20, ct)
        tr   = f_trend(prior, stat, 'over', ct)
        cu   = f_cushion(prior, stat, line, 'over')
        rst  = f_rest(prior, ct)
        # Neutral factors fixed at 0.50 (no live context in backtest)
        mtch = pace = inj = blot = ha = vs = 0.50

        fresh   = f_freshness(prior, ct)
        primary = [lv, mtch, hr20, tr, cu]
        agree   = sum(1 for f in primary if f >= 0.55)
        cons    = 3 if agree >= 4 else (0 if agree >= 3 else (-4 if agree >= 2 else -10))
        avg_mins = sum(g.get('minutes') or 0 for g in prior[:10]) / min(10, len(prior))
        star     = 3 if (avg_mins >= 36 and lv >= 0.58 and hr20 >= 0.55) else 0

        col = STAT_COLS[stat]
        hit = (actual.get(col) or 0) > line

        records.append({
            'stat':      stat,
            'factors':   np.array([lv, mtch, hr20, tr, cu, pace, inj, rst, blot, ha, vs], dtype=np.float32),
            'freshness': fresh,
            'consensus': cons,
            'star':      star,
            'hit':       hit,
        })

    print(f"  {len(records)} props ready, {skipped} skipped\n")

    # -- Evaluate both weight sets ---------------------------------------------
    stats_list = list(STAT_COLS.keys())

    def evaluate_weights(weight_dict, label):
        results = {
            'label': label,
            'overall': {'n': 0, 'dir_correct': 0, 'high_n': 0, 'high_hits': 0},
            'by_stat': {},
        }
        bucket_hits   = defaultdict(int)   # bucket -> hits
        bucket_counts = defaultdict(int)   # bucket -> total

        for r in records:
            stat    = r['stat']
            weights = weight_dict.get(stat, weight_dict['points'])
            thresh  = HIGH_THRESH.get(stat, 68)
            score   = score_prop(r['factors'], r['freshness'], r['consensus'], r['star'], weights)
            hit     = r['hit']

            # Overall directional accuracy (score > 50 = model predicts hit)
            results['overall']['n'] += 1
            if (score > 50) == hit:
                results['overall']['dir_correct'] += 1

            # HIGH accuracy
            if score >= thresh:
                results['overall']['high_n']    += 1
                results['overall']['high_hits'] += int(hit)

            # By stat
            if stat not in results['by_stat']:
                results['by_stat'][stat] = {'n': 0, 'dir_correct': 0, 'high_n': 0, 'high_hits': 0}
            s = results['by_stat'][stat]
            s['n'] += 1
            if (score > 50) == hit:
                s['dir_correct'] += 1
            if score >= thresh:
                s['high_n']    += 1
                s['high_hits'] += int(hit)

            # Calibration buckets (overall)
            bucket = int(score // 10) * 10
            bucket = max(50, min(bucket, 90))
            bucket_counts[bucket] += 1
            bucket_hits[bucket]   += int(hit)

        results['calibration'] = {
            b: {'n': bucket_counts[b], 'hits': bucket_hits[b],
                'hit_rate': round(bucket_hits[b] / bucket_counts[b], 3) if bucket_counts[b] else None}
            for b in sorted(bucket_counts)
        }
        return results

    old_res = evaluate_weights(OLD_WEIGHTS, 'OLD (universal W)')
    new_res = evaluate_weights(NEW_WEIGHTS, 'NEW (per-stat optimized)')

    # -- Print comparison ------------------------------------------------------
    def pct(n, d):
        return f"{n/d*100:.1f}%" if d else "n/a"

    print("=" * 70)
    print(f"  MODEL ACCURACY COMPARISON  ({len(records):,} historical OVER props)")
    print("=" * 70)

    # Overall
    for res in [old_res, new_res]:
        ov = res['overall']
        print(f"\n  {res['label']}")
        print(f"    Directional accuracy : {pct(ov['dir_correct'], ov['n'])}  ({ov['dir_correct']}/{ov['n']})")
        print(f"    HIGH-confidence acc  : {pct(ov['high_hits'], ov['high_n'])}  ({ov['high_hits']}/{ov['high_n']})")

    # Delta
    old_ov, new_ov = old_res['overall'], new_res['overall']
    dir_delta  = (new_ov['dir_correct']/new_ov['n'] - old_ov['dir_correct']/old_ov['n']) * 100
    high_delta = ((new_ov['high_hits']/new_ov['high_n'] if new_ov['high_n'] else 0) -
                  (old_ov['high_hits']/old_ov['high_n'] if old_ov['high_n'] else 0)) * 100
    print(f"\n  Delta  directional: {dir_delta:+.1f}pp   HIGH: {high_delta:+.1f}pp")

    # Per-stat breakdown
    print(f"\n{'-'*70}")
    print(f"  {'STAT':<16} {'OLD dir':>8} {'NEW dir':>8} {'delta':>7}  |  {'OLD HIGH':>10} {'NEW HIGH':>10} {'delta':>7}")
    print(f"{'-'*70}")
    for stat in stats_list:
        ov_s   = old_res['by_stat'].get(stat, {})
        nv_s   = new_res['by_stat'].get(stat, {})
        old_da = ov_s['dir_correct']/ov_s['n'] if ov_s.get('n') else 0
        new_da = nv_s['dir_correct']/nv_s['n'] if nv_s.get('n') else 0
        old_ha = ov_s['high_hits']/ov_s['high_n'] if ov_s.get('high_n') else None
        new_ha = nv_s['high_hits']/nv_s['high_n'] if nv_s.get('high_n') else None

        old_da_s = f"{old_da*100:.1f}%"
        new_da_s = f"{new_da*100:.1f}%"
        dir_d    = f"{(new_da-old_da)*100:+.1f}pp"
        old_ha_s = f"{old_ha*100:.1f}% ({ov_s['high_hits']}/{ov_s['high_n']})" if old_ha is not None else "n/a"
        new_ha_s = f"{new_ha*100:.1f}% ({nv_s['high_hits']}/{nv_s['high_n']})" if new_ha is not None else "n/a"
        high_d   = f"{(new_ha-old_ha)*100:+.1f}pp" if (old_ha is not None and new_ha is not None) else "—"
        print(f"  {stat:<16} {old_da_s:>8} {new_da_s:>8} {dir_d:>7}  |  {old_ha_s:>10} {new_ha_s:>10} {high_d:>7}")

    # Calibration comparison
    print(f"\n{'-'*70}")
    print(f"  CALIBRATION BY SCORE BUCKET (how often model is right at each confidence level)")
    print(f"  {'Bucket':<10} {'OLD hit%':>10} {'OLD n':>7}  |  {'NEW hit%':>10} {'NEW n':>7}")
    print(f"{'-'*70}")
    all_buckets = sorted(set(old_res['calibration']) | set(new_res['calibration']))
    for b in all_buckets:
        oc = old_res['calibration'].get(b, {})
        nc = new_res['calibration'].get(b, {})
        o_pct = f"{oc['hit_rate']*100:.1f}%" if oc.get('hit_rate') is not None else "—"
        n_pct = f"{nc['hit_rate']*100:.1f}%" if nc.get('hit_rate') is not None else "—"
        print(f"  {b}-{b+9:<8} {o_pct:>10} {oc.get('n', 0):>7}  |  {n_pct:>10} {nc.get('n', 0):>7}")

    # Save to JSON
    out = {
        'generated_at': datetime.now().isoformat(),
        'n_props': len(records),
        'old': {
            'label': old_res['label'],
            'overall': old_res['overall'],
            'by_stat': old_res['by_stat'],
            'calibration': old_res['calibration'],
        },
        'new': {
            'label': new_res['label'],
            'overall': new_res['overall'],
            'by_stat': new_res['by_stat'],
            'calibration': new_res['calibration'],
        },
        'delta': {
            'directional_pp': round(dir_delta, 2),
            'high_confidence_pp': round(high_delta, 2),
        },
    }
    with open('weight_comparison_results.json', 'w') as f:
        json.dump(out, f, indent=2)
    print(f"\nSaved to weight_comparison_results.json")


if __name__ == '__main__':
    main()
