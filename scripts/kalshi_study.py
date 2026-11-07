"""Run the pre-registered Kalshi calibration study: update kalshi_pockets / kalshi_calibration.
Usage: python kalshi_study.py [--report]   (--report also writes docs/kalshi-study/<date>-calibration.{md,json})"""
import json, os, sys
from datetime import date
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.study import calibration, evaluate, render_report  # noqa: E402

COLS = "ticker,player,stat,strike,game_date,season,pretip_yes_bid,pretip_yes_ask,pretip_volume,result"
MIN_DISCOVERY_ROWS = 1000

if __name__ == '__main__':
    load_env_local()
    rows = sb.select_all("kalshi_settled", f"select={COLS}&order=ticker")
    n_disc = sum(r["season"] == "2025-26" for r in rows)
    if n_disc < MIN_DISCOVERY_ROWS:
        print(f"kalshi_study: only {n_disc} 2025-26 rows; backfill incomplete, not writing pockets")
        sys.exit(1)
    fwd = sb.select_all("kalshi_pocket_trades", "select=pocket_id,price,fee,pnl,won&won=not.is.null&order=id")
    pockets, cal = evaluate(rows, fwd), calibration(rows)
    sb.upsert("kalshi_pockets", pockets, "id")
    sb.upsert("kalshi_calibration", cal, "season,band")
    print(f"kalshi_study: {len(rows)} rows, {sum(p['status'] != 'rejected' for p in pockets)} pockets passed discovery")
    if '--report' in sys.argv:
        out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs', 'kalshi-study')
        os.makedirs(out, exist_ok=True)
        stem = os.path.join(out, f"{date.today().isoformat()}-calibration")
        with open(stem + '.md', 'w', encoding='utf-8') as f:
            f.write(render_report(pockets, cal, len(rows)))
        with open(stem + '.json', 'w', encoding='utf-8') as f:
            json.dump({"n_rows": len(rows), "pockets": pockets, "calibration": cal}, f, indent=1)
        print(f"report: {stem}.md")
