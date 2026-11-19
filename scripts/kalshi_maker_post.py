"""Pipeline step (kalshi_live, every 15 min): post PAPER resting bids for the Kalshi maker test
(spec 2026-11-19-kalshi-maker-paper-test-design.md). Public reads + Supabase writes only:
this never places a Kalshi order."""
import os, sys, time
from datetime import date, datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests  # noqa: E402
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.history import tips_cache  # noqa: E402
from kalshi_edges.market_data import _dollars, _game_of, fetch_markets  # noqa: E402
from kalshi_edges.maker_quotes import (END_DATE, PAUSE_S, POST_SERIES, eligible_sides, fetch_orderbook,  # noqa: E402
                                       make_quote, tip_for)

if __name__ == '__main__':
    load_env_local()
    now = datetime.now(timezone.utc)
    if now.date() > END_DATE + timedelta(days=1):
        print("kalshi_maker_post: test ended", END_DATE); sys.exit(0)
    sess = requests.Session()
    tips_for = tips_cache(sess)
    since = (now.date() - timedelta(days=2)).isoformat()
    have = {(r["ticker"], r["side"]) for r in
            sb.select_all("kalshi_maker_quotes", f"select=ticker,side&game_date=gte.{since}&order=id")}
    rows, seen, errors = [], 0, 0
    for series, market in POST_SERIES.items():
        try:
            raws = fetch_markets(series, session=sess)
        except Exception as e:  # noqa: BLE001  one bad series must not stop the others
            print("kalshi_maker_post: series", series, type(e).__name__); errors += 1; continue
        for raw in raws:
            gd, away, home = _game_of(raw.get("ticker"))
            if gd is None or gd > END_DATE:
                continue
            try:
                tip = tip_for(tips_for(gd), away, home)
            except Exception:  # noqa: BLE001  ESPN hiccup: skip this run
                errors += 1; continue
            sides = [s for s, _ in eligible_sides(_dollars(raw.get("yes_bid_dollars")),
                                                   _dollars(raw.get("yes_ask_dollars")), now, tip)
                     if (raw["ticker"], s) not in have]
            if not sides:
                continue
            seen += 1
            try:
                book = fetch_orderbook(sess, raw["ticker"])
            except Exception:  # noqa: BLE001  skip this rung this run
                errors += 1; continue
            time.sleep(PAUSE_S)
            for s in sides:
                q = make_quote(raw["ticker"], market, s, book, now, tip, gd.isoformat())
                if q:
                    rows.append(q)
    n = sb.insert_ignore("kalshi_maker_quotes", rows, "ticker,side")
    print(f"kalshi_maker_post: {seen} eligible rungs, {len(rows)} quotes built, {n} new, {errors} errors")
