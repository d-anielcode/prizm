"""Pipeline step (kalshi_live, every 15 min): price every Kalshi ladder rung for today's
games from the sportsbook model (full-ladder bridge, spec 2026-11-11) into kalshi_model_rungs."""
import os, sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.ladder_model import LADDER_STATS, build_rungs, et_day_window  # noqa: E402
from kalshi_edges.prizm_data import load_calibration  # noqa: E402

LOG_COLS = "player_name,game_date,minutes,points,rebounds,assists,fg3m,pra"
SCORED_COLS = "player_name,stat_type,line,direction,confidence_score,commence_time"
LOG_LOOKBACK_DAYS = 400   # covers 40 games across an offseason


def _in(values):
    return ",".join(f'"{quote(v)}"' for v in values)


if __name__ == '__main__':
    load_env_local()
    today = datetime.now(ZoneInfo('America/New_York')).date()
    stats = ",".join(LADDER_STATS)
    markets = sb.select_all("kalshi_markets", f"select=ticker,player,stat,strike,game_date"
                                              f"&game_date=eq.{today.isoformat()}&stat=in.({stats})&order=ticker")
    if not markets:
        print("kalshi_model_rungs: no ladder markets today"); sys.exit(0)
    start, end = et_day_window(today)
    scored = []
    for table in ("props", "prop_alts"):
        scored += sb.select_all(table, f"select={SCORED_COLS}&confidence_score=not.is.null"
                                       f"&stat_type=in.({stats})&commence_time=gte.{quote(start)}"
                                       f"&commence_time=lt.{quote(end)}&order=id")
    names = sorted({r["player_name"] for r in scored})
    since = (today - timedelta(days=LOG_LOOKBACK_DAYS)).isoformat()
    logs = []
    for i in range(0, len(names), 40):
        logs += sb.select_all("player_game_logs", f"select={LOG_COLS}&player_name=in.({_in(names[i:i + 40])})"
                                                  f"&game_date=gte.{since}&order=id")
    now = datetime.now(timezone.utc).isoformat()
    rows, skips = build_rungs(markets, scored, logs, load_calibration(), today.isoformat(), now)
    n = sb.upsert("kalshi_model_rungs", rows, "ticker")
    exact = sum(r["exact"] for r in rows)
    print(f"kalshi_model_rungs: {len(markets)} markets, {n} rungs priced ({exact} exact, {n - exact} stretched), "
          f"skipped ladders {skips}")
