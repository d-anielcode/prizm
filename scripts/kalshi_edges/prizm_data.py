"""Supabase reader + calibration loader for the Kalshi edge finder.

Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY from the environment
(source .env.local before running the CLI).
"""
import os
import json
import math
import requests

SB_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

def _sb_get(table, params=""):
    rows, offset = [], 0
    while True:
        sep = "&" if params else ""
        url = f"{SB_URL}/rest/v1/{table}?{params}{sep}limit=1000&offset={offset}"
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows

def todays_props(game_date):
    """Scored props for a given game_date (YYYY-MM-DD)."""
    return _sb_get(
        "props",
        f"select=player_name,stat_type,direction,line,confidence_score,game_date"
        f"&game_date=eq.{game_date}&confidence_score=not.is.null",
    )

def all_logs():
    """All player game logs, most recent first."""
    return _sb_get("player_game_logs", "order=game_date.desc")

def load_calibration(path="lib/calibration-table.json"):
    with open(path) as f:
        return json.load(f)

def apply_calibration(table, stat, score):
    """Map a confidence score (0-100) to P(prop hits), in [0,1].

    Mirrors lib/calibration.ts: per-stat lookup preferred, global as fallback,
    linear interpolation between integer scores. Table values are percents.
    """
    arr = (table.get("per_stat") or {}).get(stat) or table["lookup"]
    s = min(max(float(score), 0.0), 100.0)
    lo = int(math.floor(s))
    hi = min(lo + 1, len(arr) - 1)
    frac = s - lo
    pct = arr[lo] * (1 - frac) + arr[hi] * frac
    return pct / 100.0
