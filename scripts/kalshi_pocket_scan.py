"""Pipeline step (pretip): log paper trades for confirmed/live pockets on games tipping within 45 min."""
import os, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.espn import fetch_tip_index  # noqa: E402
from kalshi_edges.pockets_live import ACTIVE_STATUSES, scan_trades  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    active = {p["id"] for p in sb.select_all(
        "kalshi_pockets", f"select=id&status=in.({','.join(ACTIVE_STATUSES)})&order=id")}
    if not active:
        print("kalshi_pocket_scan: no confirmed pockets"); sys.exit(0)
    today = datetime.now(ZoneInfo('America/New_York')).date()
    rows = sb.select_all("kalshi_markets", f"select=ticker,player,stat,strike,game_date,yes_bid,yes_ask,volume"
                                           f"&game_date=eq.{today.isoformat()}&order=ticker")
    trades = scan_trades(rows, fetch_tip_index(today), datetime.now(timezone.utc), active)
    n = sb.insert_ignore("kalshi_pocket_trades", trades, "pocket_id,ticker,side")
    print(f"kalshi_pocket_scan: {len(trades)} candidates, {n} new paper trades")
