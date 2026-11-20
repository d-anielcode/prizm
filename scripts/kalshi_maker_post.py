"""PC scheduled task "Prizm Kalshi maker post" (every 15 min, 1pm-11pm PT): post PAPER resting bids for the Kalshi maker test
(spec 2026-11-19-kalshi-maker-paper-test-design.md). Public reads + Supabase writes only:
this never places a Kalshi order. Runs on the user's PC, not GitHub: the GitHub 15-min cron
fires only ~2x/day, which misses most 3h pre-tip windows."""
import os, sys, time
from datetime import date, datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests  # noqa: E402
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.history import tips_cache  # noqa: E402
from kalshi_edges.market_data import _dollars, _game_of, fetch_markets  # noqa: E402
from kalshi_edges.maker_quotes import (END_DATE, PAUSE_S, POST_SERIES, eligible_sides, fetch_orderbook,  # noqa: E402
                                       make_quote, tip_for, date_window)

DEADLINE_S = 600

if __name__ == '__main__':
    if not (sys.stdout and sys.stdout.isatty()):  # scheduled task / no console (scheduled task): append output to .logs\kalshi-maker.log
        logs = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.logs')
        os.makedirs(logs, exist_ok=True)
        sys.stdout = sys.stderr = open(os.path.join(logs, 'kalshi-maker.log'), 'a', encoding='utf-8')
        print(datetime.now(timezone.utc).isoformat(), end=' ')
    load_env_local()
    now = datetime.now(timezone.utc)
    if now.date() > END_DATE + timedelta(days=1):
        print("kalshi_maker_post: test ended", END_DATE); sys.exit(0)
    sess = requests.Session()
    tips_for = tips_cache(sess)
    since = (now.date() - timedelta(days=2)).isoformat()
    have = {(r["ticker"], r["side"]) for r in
            sb.select_all("kalshi_maker_quotes", f"select=ticker,side&game_date=gte.{since}&order=id")}
    rows, seen, errors, inserted, built = [], 0, 0, 0, 0
    failed_dates, ok_window = set(), date_window(now)
    t0, deadline_hit = time.monotonic(), False
    for series, market in POST_SERIES.items():
        if deadline_hit:
            break
        rows = []
        try:
            raws = fetch_markets(series, session=sess)
        except Exception as e:  # noqa: BLE001  one bad series must not stop the others
            print("kalshi_maker_post: series", series, type(e).__name__); errors += 1; continue
        for raw in raws:
            if time.monotonic() - t0 > DEADLINE_S:
                deadline_hit = True
                print(f"kalshi_maker_post: deadline {DEADLINE_S}s hit; inserting what was built")
                break
            gd, away, home = _game_of(raw.get("ticker"))
            if gd is None or gd > END_DATE or gd not in ok_window or gd in failed_dates:
                continue
            try:
                tip = tip_for(tips_for(gd), away, home)
            except Exception:  # noqa: BLE001  ESPN hiccup: skip this date for the rest of the run
                failed_dates.add(gd); errors += 1; continue
            sides = [s for s, _ in eligible_sides(_dollars(raw.get("yes_bid_dollars")),
                                                   _dollars(raw.get("yes_ask_dollars")), now, tip)
                     if (raw["ticker"], s) not in have]
            if not sides:
                continue
            seen += 1
            try:
                book_ts = datetime.now(timezone.utc)   # trades before this are already in the book's queue
                book = fetch_orderbook(sess, raw["ticker"])
                for s in sides:
                    q = make_quote(raw["ticker"], market, s, book, book_ts, tip, gd.isoformat())
                    if q:
                        rows.append(q)
            except Exception:  # noqa: BLE001  skip this rung this run
                errors += 1; continue
            time.sleep(PAUSE_S)
        built += len(rows)
        inserted += sb.insert_ignore("kalshi_maker_quotes", rows, "ticker,side")
    print(f"kalshi_maker_post: {seen} eligible rungs, {built} quotes built, {inserted} new, {errors} errors")
