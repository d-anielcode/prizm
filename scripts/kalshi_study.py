"""Run the pre-registered Kalshi calibration study: update kalshi_pockets / kalshi_calibration.
Usage: python kalshi_study.py [--report]   (--report also writes docs/kalshi-study/<date>-calibration.{md,json})

Refuses (exit 1, nothing written) until the 2025-26 backfill is complete. Confirmation and
forward verdicts already stored in kalshi_pockets are carried over (frozen), never re-decided."""
import json, os, sys
from datetime import date, datetime, timezone
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.study import build_trades, calibration, discovery_complete, evaluate, render_report  # noqa: E402

COLS = "ticker,player,stat,strike,game_date,season,pretip_yes_bid,pretip_yes_ask,pretip_volume,result"
PREV_COLS = "id,conf_verdict,conf_decided_at,fwd_verdict,fwd_decided_at"

if __name__ == '__main__':
    load_env_local()
    rows = sb.select_all("kalshi_settled", f"select={COLS}&order=ticker")
    ok, reason = discovery_complete(rows)
    if not ok:
        print(f"kalshi_study: backfill incomplete ({reason}); not writing pockets")
        sys.exit(1)
    fwd = sb.select_all("kalshi_pocket_trades", "select=pocket_id,price,fee,pnl,won&won=not.is.null&order=id")
    previous = {p["id"]: p for p in sb.select_all("kalshi_pockets", f"select={PREV_COLS}&order=id")}
    now = datetime.now(timezone.utc).isoformat()
    pockets, cal = evaluate(rows, fwd, previous=previous, now=now), calibration(rows)
    sb.upsert("kalshi_pockets", [{**p, "updated_at": now} for p in pockets], "id")
    sb.upsert("kalshi_calibration", [{**c, "updated_at": now} for c in cal], "season,band")
    print(f"kalshi_study: {len(rows)} rows, {sum(p['status'] != 'rejected' for p in pockets)} pockets passed discovery")
    if '--report' in sys.argv:
        out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'kalshi-study')
        os.makedirs(out, exist_ok=True)
        stem = os.path.join(out, f"{date.today().isoformat()}-calibration")
        with open(stem + '.md', 'w', encoding='utf-8') as f:
            f.write(render_report(pockets, cal, len(rows), build_trades(rows)))
        with open(stem + '.json', 'w', encoding='utf-8') as f:
            json.dump({"n_rows": len(rows), "pockets": pockets, "calibration": cal}, f, indent=1)
        print(f"report: {stem}.md")
