"""
Investigate factor collinearity, specifically the last10HitRate puzzle.

Tonight's Module 8 found last10HitRate at -0.24 (anti-correlated) while
last20HitRate fits at +1.16. Two hypotheses:

  A) Multicollinearity: last10 and last20 are near-duplicates, the negative
     coefficient is the logreg compensating for double-counting.
  B) Mean reversion: short-window streaks systematically over-predict, so
     last10 carries genuine anti-signal beyond what last20 captures.

This script discriminates between them by:
  1. Computing the Pearson correlation between last10 and last20 features.
  2. Fitting three logreg models: full (both), only-last10, only-last20.
  3. Comparing val AUC across the three to see which window is doing the work.
  4. Computing variance inflation factor (VIF) for both — VIF > 10 = severe
     multicollinearity per the standard threshold.

Usage:  py scripts/investigate_collinearity.py
"""

import os, sys, json, re
from datetime import datetime
from pathlib import Path

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
    print("ERROR: Missing supabase env vars"); sys.exit(1)

HDR = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'}

def sb_get_all(table, params=''):
    rows, offset = [], 0
    while True:
        sep = '&' if params else ''
        url = f'{SUPABASE_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}'
        r = requests.get(url, headers=HDR, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch: break
        rows.extend(batch)
        if len(batch) < 1000: break
        offset += 1000
    return rows


# ── Factor functions — mirror lib/confidence.ts logic ────────────────────────

def get_stat(log, stat_type):
    return {'points': float(log.get('points', 0) or 0),
            'rebounds': float(log.get('rebounds', 0) or 0),
            'assists': float(log.get('assists', 0) or 0),
            'steals': float(log.get('steals', 0) or 0),
            'blocks': float(log.get('blocks', 0) or 0),
            'three_pointers': float(log.get('fg3m', 0) or 0),
            'pra': float(log.get('pra', 0) or 0)}.get(stat_type, 0.0)


def factor_last_n_hitrate(prior, stat_type, line, direction, n):
    sl = prior[:n]
    if len(sl) < 3: return None
    if direction == 'over':
        hits = sum(1 for g in sl if get_stat(g, stat_type) > line)
    else:
        hits = sum(1 for g in sl if get_stat(g, stat_type) < line)
    return hits / len(sl)


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    print("Factor Collinearity Investigation")
    print("=" * 60)

    print("\n[1/3] Loading data…")
    grades = sb_get_all('prop_grades', 'order=game_date.asc')
    grades = [g for g in grades if g.get('hit') is not None]
    raw_logs = sb_get_all('player_game_logs')
    logs_by_player = {}
    for log in raw_logs:
        if log.get('player_name') and log.get('game_date'):
            logs_by_player.setdefault(log['player_name'], []).append(log)
    print(f"  {len(grades):,} graded props · {len(raw_logs):,} game logs · "
          f"{len(logs_by_player)} players")

    print("\n[2/3] Building feature vectors…")
    cases = []
    for g in grades:
        player = g['player_name']
        if player not in logs_by_player: continue
        stat = g['stat_type']
        try:
            line = float(g['line'])
        except (TypeError, ValueError):
            continue
        direction = g.get('direction', 'over')
        game_date = g['game_date']
        hit = 1 if g['hit'] else 0
        all_logs = sorted(logs_by_player[player], key=lambda l: l['game_date'])
        prior = list(reversed([l for l in all_logs if l['game_date'] < game_date]))
        if len(prior) < 10: continue
        l10 = factor_last_n_hitrate(prior, stat, line, direction, 10)
        l20 = factor_last_n_hitrate(prior, stat, line, direction, 20)
        if l10 is None or l20 is None: continue
        cases.append({'l10': l10, 'l20': l20, 'hit': hit})
    print(f"  {len(cases):,} cases with both windows computable")

    if len(cases) < 1000:
        print("  Not enough data, exiting"); return

    try:
        import numpy as np
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import roc_auc_score
    except ImportError:
        print("  Need scikit-learn + numpy"); return

    l10 = np.array([c['l10'] for c in cases])
    l20 = np.array([c['l20'] for c in cases])
    y   = np.array([c['hit'] for c in cases])

    # 1. Pearson correlation between l10 and l20
    print("\n[3/3] Correlation + ablation analysis")
    rho = float(np.corrcoef(l10, l20)[0, 1])
    print(f"\n  Pearson(l10, l20) = {rho:.4f}")
    print(f"    {'multicollinearity' if abs(rho) > 0.85 else 'moderate overlap' if abs(rho) > 0.6 else 'independent'} "
          f"(>0.85 = severe per common threshold)")

    # 2. Chronological 75/25 split (cases already sorted ascending by game_date)
    split = int(len(cases) * 0.75)
    Xfull_tr, Xfull_va = np.column_stack([l10[:split], l20[:split]]), np.column_stack([l10[split:], l20[split:]])
    Xl10_tr, Xl10_va   = l10[:split].reshape(-1, 1),                   l10[split:].reshape(-1, 1)
    Xl20_tr, Xl20_va   = l20[:split].reshape(-1, 1),                   l20[split:].reshape(-1, 1)
    y_tr, y_va         = y[:split], y[split:]

    print(f"\n  Train: {len(y_tr):,} | Val: {len(y_va):,}")

    def fit_and_score(Xtr, Xva, ytr, yva, label):
        clf = LogisticRegression(max_iter=2000)
        clf.fit(Xtr, ytr)
        proba = clf.predict_proba(Xva)[:, 1]
        auc = float(roc_auc_score(yva, proba))
        coefs = clf.coef_[0].tolist()
        return auc, coefs

    auc_full, coefs_full = fit_and_score(Xfull_tr, Xfull_va, y_tr, y_va, "full")
    auc_l10,  coefs_l10  = fit_and_score(Xl10_tr,  Xl10_va,  y_tr, y_va, "l10")
    auc_l20,  coefs_l20  = fit_and_score(Xl20_tr,  Xl20_va,  y_tr, y_va, "l20")

    print(f"\n  Model              Val AUC    Coefs")
    print(f"  {'-'*55}")
    print(f"  full (l10 + l20)   {auc_full:.4f}    l10={coefs_full[0]:+.4f}  l20={coefs_full[1]:+.4f}")
    print(f"  only l10           {auc_l10:.4f}    l10={coefs_l10[0]:+.4f}")
    print(f"  only l20           {auc_l20:.4f}    l20={coefs_l20[0]:+.4f}")

    print("\n  Interpretation:")
    if auc_l20 >= auc_full - 0.002:
        print("    l20 alone matches the full model -> l10 is REDUNDANT.")
        print("    The negative coef in the full model is multicollinearity")
        print("    compensation. Safe to drop last10HitRate from the weight set.")
    elif auc_l10 >= auc_full - 0.002:
        print("    l10 alone matches the full model -> l20 is REDUNDANT.")
        print("    Consider dropping l20 instead.")
    elif auc_full > max(auc_l10, auc_l20) + 0.002:
        print("    Both windows add genuine independent signal — keep both.")
        print("    The negative coef in the full fit captures a real mean-reversion")
        print("    or noise-cancellation effect between the two windows.")
    else:
        print("    Effects are too close to call decisively. Re-run with more data.")

    # 3. Variance Inflation Factor — VIF > 10 is severe collinearity.
    # For a 2-variable problem: VIF = 1 / (1 - r²).
    if abs(rho) < 0.999:
        vif = 1.0 / (1.0 - rho * rho)
        print(f"\n  VIF (both features): {vif:.2f}")
        print(f"    {'severe collinearity' if vif > 10 else 'moderate' if vif > 5 else 'mild'} "
              f"(>10 typically warrants dropping one)")


if __name__ == '__main__':
    main()
