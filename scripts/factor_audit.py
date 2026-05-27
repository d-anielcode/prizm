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

def load(stat: str) -> pd.DataFrame:
    supabase_url = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    rows, offset = [], 0
    while True:
        url = (f"{supabase_url}/rest/v1/prop_features"
               f"?stat_type=eq.{stat}&limit=1000&offset={offset}")
        r = requests.get(url, headers=headers, timeout=60); r.raise_for_status()
        page = r.json()
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return pd.DataFrame(rows)

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
    df = df.dropna(subset=FEATURES + ["hit"])
    print(f"  n after dropna: {len(df)}")
    if len(df) < min_samples:
        print(f"  INSUFFICIENT (need >= {min_samples})"); return None
    X = sm.add_constant(df[FEATURES])
    y = df["hit"].astype(int)
    model = sm.Logit(y, X).fit(disp=False)
    print(model.summary().tables[1])

    significant = []
    for feat in FEATURES:
        coef = model.params[feat]; p = model.pvalues[feat]
        if p < 0.10 and abs(coef) > 0:
            significant.append((feat, coef, p))

    print("\n== Significant factors (p<0.10) ==")
    if not significant:
        print("  NONE — model has no separating signal for this stat")
        return None
    for f, c, p in significant:
        print(f"  {f:<18} coef={c:+.3f}  p={p:.3f}")

    total = sum(abs(c) for _, c, _ in significant)
    weights = {f: round(abs(c)/total, 3) for f, c, _ in significant}
    print("\n== Recommended weights (normalized abs-coefficient) ==")
    print(json.dumps(weights, indent=2))
    return weights

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stat")
    parser.add_argument("--min-samples", type=int, default=200)
    args = parser.parse_args()
    print(f"Auditing stat: {args.stat}")
    df = load(args.stat)
    print(f"Loaded {len(df)} rows from prop_features")
    if len(df) == 0:
        print("No data."); return
    univariate(df)
    regression(df, args.min_samples)

if __name__ == "__main__":
    main()
