"""Pipeline step (overnight): score PAPER maker quotes (spec 2026-11-19). For each unscored quote whose
tip is 3h+ past: pull the market result and its trades, apply the queue-aware fill rule, write
filled/fill_ts/result/fee/pnl. Idempotent (only scored_at IS NULL rows). Quotes still unscorable
after 7 days are voided."""
import os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests  # noqa: E402
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.market_data import fetch_market  # noqa: E402
from kalshi_edges.maker_quotes import _ts, fetch_trades, fill_time, score, settled_result  # noqa: E402

GRACE = timedelta(hours=3)
GIVE_UP = timedelta(days=7)

if __name__ == '__main__':
    load_env_local()
    now = datetime.now(timezone.utc)
    rows = sb.select_all("kalshi_maker_quotes", "select=*&scored_at=is.null&order=id")
    sess = requests.Session()
    results, trades = {}, {}
    done = waiting = voided = errors = 0
    last_tip = {}
    for r in rows:
        last_tip[r["ticker"]] = max(last_tip.get(r["ticker"], _ts(r["tip_time"])), _ts(r["tip_time"]))
    for q in rows:
        tip = _ts(q["tip_time"])
        if now - tip < GRACE:
            continue
        t = q["ticker"]
        try:
            if t not in results:
                results[t] = settled_result(fetch_market(t, session=sess))
            if results[t] is not None and t not in trades:
                lo = min(_ts(r["posted_at"]) for r in rows if r["ticker"] == t)
                trades[t] = fetch_trades(sess, t, lo.timestamp(), last_tip[t].timestamp())
        except Exception as e:  # noqa: BLE001  rate limit / transient: retry next night
            print("kalshi_maker_settle:", t, type(e).__name__)
            results.setdefault(t, None)
        try:
            if results.get(t) is None or t not in trades:
                if now - tip > GIVE_UP:
                    sb.patch("kalshi_maker_quotes", f"id=eq.{q['id']}",
                             {"result": "void", "filled": None, "scored_at": now.isoformat()})
                    voided += 1
                else:
                    waiting += 1
                continue
            fields = score(q, fill_time(q, trades[t]), results[t])
            fields["scored_at"] = now.isoformat()
            sb.patch("kalshi_maker_quotes", f"id=eq.{q['id']}", fields)
            done += 1
        except Exception as e:  # noqa: BLE001  a bad row must not block later rows
            print("kalshi_maker_settle: row error", t, type(e).__name__); errors += 1
    print(f"kalshi_maker_settle: scored {done}, waiting {waiting}, voided {voided}, {errors} errors")
