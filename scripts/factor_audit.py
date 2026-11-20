#!/usr/bin/env python
"""scripts/factor_audit.py

Per-stat factor analysis. Joins prop_features with prop_grades and emits:
  1. Univariate hit-rate per factor quintile
  2. Logistic regression coefficients + p-values
  3. Recommended weight JSON (normalized abs-coefficient for p<0.10)

Usage:
    python scripts/factor_audit.py points
    python scripts/factor_audit.py rebounds --min-samples 200
"""
import os, sys, argparse, json
from typing import List, Dict
import requests
import pandas as pd
import numpy as np
import statsmodels.api as sm

FEATURES = ["line_value","matchup_edge","last20_hit_rate","trend",
            "season_cushion","pace","rest_days","blowout",
            "home_away","vs_opponent","opponent_leak","player_bias"]

def load(stat: str, train_until: str = None) -> pd.DataFrame:
    supabase_url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    # For a leak-free temporal split, restrict fitting rows to game_date <
    # train_until (game_date lives in prop_grades, joined via the FK).
    select = "*"
    extra = ""
    if train_until:
        select = "*,prop_grades!inner(game_date)"
        extra = f"&prop_grades.game_date=lt.{train_until}"
    rows, offset = [], 0
    while True:
        url = (f"{supabase_url}/rest/v1/prop_features"
               f"?stat_type=eq.{stat}&select={select}{extra}"
               f"&limit=1000&offset={offset}")
        r = requests.get(url, headers=headers, timeout=60); r.raise_for_status()
        page = r.json()
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return pd.DataFrame(rows)


def _direction(df: pd.DataFrame, feat: str) -> int:
    """Sign of the univariate relationship (top quintile minus bottom)."""
    sub = df.dropna(subset=[feat, "hit"])
    if len(sub) < 50:
        return 0
    try:
        q = pd.qcut(sub[feat], q=5, labels=False, duplicates="drop")
    except ValueError:
        return 0
    g = sub.assign(q=q).groupby("q")["hit"].mean()
    if len(g) < 2:
        return 0
    diff = g.iloc[-1] - g.iloc[0]
    return 1 if diff > 0 else (-1 if diff < 0 else 0)

def univariate(df: pd.DataFrame):
    print("\n== Univariate hit rate by quintile ==")
    for feat in FEATURES:
        if feat not in df.columns: continue
        sub = df.dropna(subset=[feat])
        if len(sub) < 50:
            print(f"  {feat:<18} insufficient (n={len(sub)})")
            continue
        sub = sub.copy()
        sub["q"] = pd.qcut(sub[feat], q=5, labels=False, duplicates="drop")
        grouped = sub.groupby("q")["hit"].agg(["count","mean"])
        spread = grouped["mean"].max() - grouped["mean"].min()
        print(f"  {feat:<18} spread={spread*100:>5.1f}pp  q5={grouped['mean'].iloc[-1]*100:>5.1f}%  q1={grouped['mean'].iloc[0]*100:>5.1f}%")

def regression(df: pd.DataFrame, min_samples: int):
    print("\n== Logistic regression ==")
    # Exclude factor columns that are absent or have too few non-null values.
    # A single fully-null column (e.g. blowout, which has no historical spread
    # source to reconstruct from) would otherwise zero the dataset via dropna.
    usable, dropped = [], []
    for feat in FEATURES:
        nn = df[feat].notna().sum() if feat in df.columns else 0
        if nn >= min_samples:
            usable.append(feat)
        else:
            dropped.append((feat, int(nn)))
    if dropped:
        print("  dropped (insufficient coverage): "
              + ", ".join(f"{f}(n={n})" for f, n in dropped))
    if not usable:
        print("  INSUFFICIENT (no factor column has enough coverage)"); return None

    df = df.dropna(subset=usable + ["hit"])
    print(f"  n after dropna: {len(df)}  (factors: {len(usable)})")
    if len(df) < min_samples:
        print(f"  INSUFFICIENT (need >= {min_samples})"); return None
    X = sm.add_constant(df[usable])
    y = df["hit"].astype(int)
    model = sm.Logit(y, X).fit(disp=False)
    print(model.summary().tables[1])

    significant = []
    for feat in usable:
        coef = model.params[feat]; p = model.pvalues[feat]
        if p < 0.10 and abs(coef) > 0:
            significant.append((feat, coef, p))

    print("\n== Significant factors (p<0.10) ==")
    if not significant:
        print("  NONE — model has no separating signal for this stat")
        return None
    for f, c, p in significant:
        print(f"  {f:<18} coef={c:+.3f}  p={p:.3f}")

    # Drop collinearity artifacts: a factor whose multivariate coefficient sign
    # contradicts its univariate direction is confounded/unstable, not real
    # signal. Keeping it (and especially weighting it by abs-coef with the wrong
    # sign) would push the score the wrong way.
    kept, dropped_flip = [], []
    for f, c, p in significant:
        d = _direction(df, f)
        if d != 0 and (c > 0) == (d > 0):
            kept.append((f, c, p, d))
        else:
            dropped_flip.append((f, c, d))
    if dropped_flip:
        print("\n== Dropped (sign flip vs univariate — collinearity) ==")
        for f, c, d in dropped_flip:
            print(f"  {f:<18} coef={c:+.3f}  univariate_dir={d:+d}")
    if not kept:
        print("\n  NO stable factors after collinearity filter")
        return None

    # Signed, normalized weights. Sign follows the (now consistent) direction so
    # synth_score applies the factor in the correct direction.
    total = sum(abs(c) for _, c, _, _ in kept)
    weights = {f: round((abs(c)/total) * (1 if d > 0 else -1), 3)
               for f, c, _, d in kept}
    print("\n== Recommended SIGNED weights (collinearity-filtered) ==")
    print(json.dumps(weights, indent=2))
    return weights

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stat")
    parser.add_argument("--min-samples", type=int, default=200)
    parser.add_argument("--train-until", default=None,
                        help="fit only on game_date < this ISO date (leak-free split)")
    args = parser.parse_args()
    print(f"Auditing stat: {args.stat}"
          + (f"  (train window: game_date < {args.train_until})" if args.train_until else ""))
    df = load(args.stat, train_until=args.train_until)
    print(f"Loaded {len(df)} rows from prop_features")
    if len(df) == 0:
        print("No data."); return
    univariate(df)
    regression(df, args.min_samples)

if __name__ == "__main__":
    main()
