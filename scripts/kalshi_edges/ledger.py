"""Paper-trade ledger: pure grading/report math + Supabase I/O (below)."""
from collections import defaultdict

# Pre-registered go-live bar (spec). Do not tune after seeing results.
BAR = {"min_n": 300, "min_roi": 0.03}

def grade(side, price, fee, result):
    """(won, pnl per contract). result is Kalshi's 'yes'/'no'; anything else = void."""
    if result not in ("yes", "no"):
        return None, 0.0
    won = result == side
    return won, (1.0 - price - fee) if won else -(price + fee)

def side_mid(side, yes_bid, yes_ask):
    mid = (yes_bid + yes_ask) / 2.0
    return mid if side == "yes" else 1.0 - mid

def _roi(rows):
    """P&L per dollar risked (price + fee per contract)."""
    staked = sum(r["price"] + r["fee"] for r in rows)
    return sum(r["pnl"] for r in rows) / staked if staked else 0.0

def report(rows):
    graded = sorted([r for r in rows if r.get("won") is not None], key=lambda r: r["scan_date"])
    n = len(graded)
    half = n // 2
    clvs = [r["clv_mid"] - r["price"] for r in graded if r.get("clv_mid") is not None]
    by = defaultdict(list)
    for r in graded:
        by[(r["stat_type"], r["side"])].append(r)
    rep = {
        "n": n,
        "win_rate": sum(r["won"] for r in graded) / n if n else 0.0,
        "roi": _roi(graded),
        "roi_first_half": _roi(graded[:half]),
        "roi_second_half": _roi(graded[half:]),
        "mean_clv": sum(clvs) / len(clvs) if clvs else 0.0,
        "n_clv": len(clvs),
        "by_stat_side": {f"{s}:{d}": (len(v), round(_roi(v), 4)) for (s, d), v in sorted(by.items())},
    }
    rep["passes_bar"] = (n >= BAR["min_n"] and rep["roi"] >= BAR["min_roi"]
                         and rep["roi_first_half"] > 0 and rep["roi_second_half"] > 0
                         and rep["mean_clv"] > 0)
    return rep


# ── Supabase I/O ─────────────────────────────────────────────────────────────
import os
from dataclasses import asdict
from datetime import timedelta
from urllib.parse import quote
import requests

TABLE = "kalshi_paper_trades"

def _sb():
    url = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return url, {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

def insert_candidates(cands, scan_date):
    """Insert scanner Candidates; duplicates (same ticker/side/date) are ignored."""
    if not cands:
        return 0
    url, h = _sb()
    rows = [{**asdict(c), "scan_date": scan_date} for c in cands]
    r = requests.post(f"{url}/{TABLE}?on_conflict=market_ticker,side,scan_date",
                      headers={**h, "Prefer": "resolution=ignore-duplicates,return=representation"},
                      json=rows, timeout=60)
    r.raise_for_status()
    return len(r.json())

def fetch_rows(params):
    url, h = _sb()
    out, offset = [], 0
    while True:
        r = requests.get(f"{url}/{TABLE}?{params}&order=id&limit=1000&offset={offset}", headers=h, timeout=60)
        r.raise_for_status()
        batch = r.json()
        out.extend(batch)
        if len(batch) < 1000:
            return out
        offset += 1000

def update_row(row_id, fields):
    url, h = _sb()
    r = requests.patch(f"{url}/{TABLE}?id=eq.{row_id}", headers=h, json=fields, timeout=60)
    r.raise_for_status()

def _ts(dt):
    """ISO timestamp, URL-encoded (the '+00:00' offset would otherwise read as a space)."""
    return quote(dt.isoformat(), safe="")

def rows_needing_clv(now, window_min=30):
    hi = now + timedelta(minutes=window_min)
    return fetch_rows(f"select=*&clv_mid=is.null&commence_time=gt.{_ts(now)}&commence_time=lte.{_ts(hi)}")

def rows_needing_grade(now, settle_hours=3):
    cutoff = now - timedelta(hours=settle_hours)
    return fetch_rows(f"select=*&graded_at=is.null&commence_time=lt.{_ts(cutoff)}")
