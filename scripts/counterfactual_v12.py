#!/usr/bin/env python
"""scripts/counterfactual_v12.py

Compare current vs proposed weights for a stat on a held-out window.

Usage:
    python scripts/counterfactual_v12.py points \
        --proposed '{"line_value":0.4,"trend":0.3,"matchup_edge":0.3}' \
        --holdout-days 7
"""
import os, sys, argparse, json, re
from datetime import date, timedelta
import requests, pandas as pd, numpy as np

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

# prop_features columns are snake_case; production weights (confidence-weights.json)
# are camelCase. Without this normalization the camelCase keys match no column and
# every prop scores a flat 50, making CURRENT un-replayable.
def normalize_weights(weights: dict) -> dict:
    out = {}
    for k, v in weights.items():
        snake = re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower()
        out[snake] = v
    return out

def load_holdout(stat: str, since: str) -> pd.DataFrame:
    rows, offset = [], 0
    while True:
        url = (f"{SUPABASE_URL}/rest/v1/prop_features"
               f"?stat_type=eq.{stat}&limit=1000&offset={offset}"
               f"&select=*,prop_grades!inner(game_date)"
               f"&prop_grades.game_date=gte.{since}")
        r = requests.get(url, headers=HEADERS, timeout=60); r.raise_for_status()
        page = r.json()
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return pd.DataFrame(rows)

def synth_score(df: pd.DataFrame, weights: dict) -> pd.Series:
    score = pd.Series(50.0, index=df.index)
    for feat, w in weights.items():
        if feat not in df.columns: continue
        v = df[feat].fillna(0)
        score = score + w * v * 50
    return score.clip(0, 100)

def bucket_report(score: pd.Series, hit: pd.Series, label: str):
    print(f"\n  -- {label} --")
    df = pd.DataFrame({"score": score, "hit": hit.astype(int)})
    df["band"] = pd.cut(df["score"], bins=[0,60,68,72,76,80,100],
                         labels=["<60","60-68","68-72","72-76","76-80","80+"])
    g = df.groupby("band", observed=True)["hit"].agg(["count","mean"])
    for band, row in g.iterrows():
        print(f"    {band:<8} n={int(row['count']):>4}  hit={row['mean']*100:>5.1f}%")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stat")
    parser.add_argument("--proposed", required=True)
    parser.add_argument("--current",  default=None)
    parser.add_argument("--holdout-days", type=int, default=7)
    args = parser.parse_args()

    since = (date.today() - timedelta(days=args.holdout_days)).isoformat()
    df = load_holdout(args.stat, since)
    print(f"Holdout window: {since} onward; n={len(df)}")
    if len(df) == 0:
        print("No data."); return

    proposed = normalize_weights(json.loads(args.proposed))

    if args.current is None:
        with open("lib/confidence-weights.json") as f:
            cfg = json.load(f)
        current = normalize_weights(cfg.get("weights", {}).get(args.stat, {}))
    else:
        current = normalize_weights(json.loads(args.current))

    cur_score = synth_score(df, current)
    new_score = synth_score(df, proposed)

    bucket_report(cur_score, df["hit"], "CURRENT")
    bucket_report(new_score, df["hit"], "PROPOSED")

if __name__ == "__main__":
    main()
