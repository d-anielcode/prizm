"""Supabase reader + calibration loader for the Kalshi edge finder.

Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY from the environment
(source .env.local before running the CLI).
"""
import os
import json
import math
from datetime import date, timedelta
import requests

SB_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SB_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}"}

# Repo root = .../scripts/kalshi_edges/prizm_data.py -> up 2 dirs. Resolving from
# the module location keeps the calibration path correct regardless of cwd.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_CALIBRATION = os.path.join(_REPO_ROOT, "lib", "calibration-table.json")

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

def todays_props(game_date=None):
    """Scored props from the current slate.

    The `props` table has no `game_date` column -- it is the live slate keyed by
    `commence_time`. When game_date (YYYY-MM-DD) is given, restrict to games
    commencing that calendar day; otherwise return the whole scored slate.
    """
    params = ("select=player_name,stat_type,direction,line,confidence_score,commence_time"
              "&confidence_score=not.is.null")
    if game_date:
        nxt = (date.fromisoformat(game_date) + timedelta(days=1)).isoformat()
        params += f"&commence_time=gte.{game_date}&commence_time=lt.{nxt}"
    return _sb_get("props", params)

def all_logs():
    """All player game logs, most recent first."""
    return _sb_get("player_game_logs", "order=game_date.desc")

def load_calibration(path=None):
    with open(path or DEFAULT_CALIBRATION) as f:
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
