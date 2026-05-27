#!/usr/bin/env python
"""scripts/build_feature_table.py

Backfill the prop_features table from prop_grades.

Usage:
    python scripts/build_feature_table.py --since 2026-04-26
    python scripts/build_feature_table.py --resume      # skip rows already present

Reads:  prop_grades, player_game_logs, historical_prop_lines, team_pace,
        team_defense, dvp_stats, opponent_leaks, player_line_bias
Writes: prop_features
"""
import os, sys, argparse, json
from datetime import date, timedelta
from typing import List, Dict, Any, Optional
import requests

sys.path.insert(0, os.path.dirname(__file__))
from confidence_features import compute_all_features

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}",
           "Content-Type": "application/json", "Prefer": "return=minimal"}

def fetch_all(path: str, params: str = "", allow_missing: bool = False) -> List[Dict[str, Any]]:
    rows, offset, PAGE = [], 0, 1000
    while True:
        sep = "&" if params else ""
        url = f"{SUPABASE_URL}/rest/v1/{path}?{params}{sep}limit={PAGE}&offset={offset}"
        r = requests.get(url, headers=HEADERS, timeout=60)
        if allow_missing and r.status_code == 404:
            print(f"  INFO: table '{path}' not found (404) — factor columns will be null")
            return []
        r.raise_for_status()
        data = r.json()
        if not data: break
        rows.extend(data)
        if len(data) < PAGE: break
        offset += PAGE
    return rows

def upsert(table: str, rows: List[Dict[str, Any]], batch_size: int = 500) -> int:
    if not rows: return 0
    written = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        url = f"{SUPABASE_URL}/rest/v1/{table}?on_conflict=prop_grade_id"
        h = {**HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"}
        r = requests.post(url, headers=h, data=json.dumps(batch), timeout=60)
        if r.status_code >= 400:
            print(f"  upsert error: {r.status_code} {r.text[:200]}")
        else:
            written += len(batch)
    return written

def build_logs_by_player_then_date(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    by_player: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        by_player.setdefault(r["player_name"], []).append(r)
    for name in by_player:
        by_player[name].sort(key=lambda g: g["game_date"], reverse=True)
    return by_player

def logs_before(all_logs: List[Dict[str, Any]], cutoff_iso: str) -> List[Dict[str, Any]]:
    return [g for g in all_logs if g["game_date"] < cutoff_iso]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default=None)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cutoff = args.since or (date.today() - timedelta(days=45)).isoformat()
    print(f"Loading graded props since {cutoff}...")
    grade_params = f"game_date=gte.{cutoff}&hit=not.is.null&select=id,game_date,player_name,stat_type,line,direction,hit"
    grades = fetch_all("prop_grades", grade_params)
    print(f"  {len(grades)} graded props")

    if args.resume:
        existing = fetch_all("prop_features", "select=prop_grade_id")
        existing_ids = {r["prop_grade_id"] for r in existing}
        grades = [g for g in grades if g["id"] not in existing_ids]
        print(f"  {len(grades)} remaining after resume filter")
    if not grades:
        print("Nothing to do."); return

    players = sorted({g["player_name"] for g in grades})
    print(f"Loading logs for {len(players)} players...")
    all_logs: List[Dict[str, Any]] = []
    for i in range(0, len(players), 50):
        chunk = players[i:i+50]
        names_param = ",".join(f'"{n}"' for n in chunk)
        lp = f"player_name=in.({names_param})&select=player_name,game_date,minutes,points,rebounds,assists,fg3m,blocks,steals,pra,is_home,matchup"
        all_logs.extend(fetch_all("player_game_logs", lp))
    logs_by_player = build_logs_by_player_then_date(all_logs)
    print(f"  {len(all_logs)} log rows for {len(logs_by_player)} players")

    league_avg_dvp = 0.0  # Task 14 wires the real value in

    out_rows: List[Dict[str, Any]] = []
    for g in grades:
        player_logs = logs_by_player.get(g["player_name"], [])
        before = logs_before(player_logs, g["game_date"])
        if not before:
            continue
        ctx: Dict[str, Any] = {
            "prop_is_home": before[0].get("is_home") if before else False,
            "opponent": None,
            "opponent_pace": None, "def_rank": None, "dvp_value": None,
            "league_avg_dvp": league_avg_dvp, "spread": None,
            "leak_value": None, "bias_hit_rate": None, "bias_sample_count": None,
        }
        prop = {"stat_type": g["stat_type"], "line": g["line"],
                "direction": g["direction"], "game_date": g["game_date"]}
        feats = compute_all_features(prop, before, ctx)
        out_rows.append({
            "prop_grade_id":    g["id"],
            "stat_type":        g["stat_type"],
            "direction":        g["direction"],
            "line":             g["line"],
            "hit":              g["hit"],
            "line_value":       feats["line_value"],
            "matchup_edge":     feats["matchup_edge"],
            "last20_hit_rate":  feats["last20_hit_rate"],
            "trend":            feats["trend"],
            "season_cushion":   feats["season_cushion"],
            "pace":             feats["pace"],
            "rest_days":        feats["rest_days"],
            "blowout":          feats["blowout"],
            "home_away":        feats["home_away"],
            "vs_opponent":      feats["vs_opponent"],
            "opponent_leak":    feats["opponent_leak"],
            "player_bias":      feats["player_bias"],
            "feature_version":  "v1",
        })

    print(f"Computed {len(out_rows)} feature rows")
    if args.dry_run:
        print("Dry run — not writing.")
        return
    written = upsert("prop_features", out_rows)
    print(f"Wrote {written} rows to prop_features.")

if __name__ == "__main__":
    main()
