"""Kalshi maker paper test report (spec 2026-11-19).

  python kalshi_maker_report.py            progress: counts + fill rate, never ROI
  python kalshi_maker_report.py --final    pre-registered verdict, per market that reached its end point
  python kalshi_maker_report.py --final --force   verdict before the end point (NOT pre-registered)
"""
import argparse, os, sys
from datetime import datetime
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.maker_quotes import MARKETS, MAKER_BAR, END_DATE, bar_check, final_ready, progress  # noqa: E402

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument("--final", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    load_env_local()
    rows = sb.select_all("kalshi_maker_quotes", "select=*&order=id")
    today = datetime.now(ZoneInfo("America/New_York")).date()
    prog = progress(rows)
    print(f"Kalshi maker paper test — bar {MAKER_BAR}, end {END_DATE}")
    for m in MARKETS:
        p = prog[m]
        print(f"{m:7} orders {p['orders']:5d}  scored {p['scored']:5d}  void {p['void']:4d}  "
              f"fill rate {p['fill_rate']:.1%}  median queue {p['median_queue']:.0f}  filled {p['n_filled']}")
    if not a.final:
        sys.exit(0)
    for m in MARKETS:
        ready = final_ready(prog[m]["n_filled"], today)
        if not ready and not a.force:
            print(f"{m}: not at end point yet (n_filled {prog[m]['n_filled']} < {MAKER_BAR['min_n']}, "
                  f"before {END_DATE}) — use --force to peek (breaks pre-registration)")
            continue
        if not ready:
            print("!!! FORCED PEEK — NOT PRE-REGISTERED, DO NOT ACT ON THIS !!!")
        r = bar_check([x for x in rows if x["market"] == m])
        print(f"{m}: n {r['n']} days {r['days']} ROI {r['roi']:+.2%} halves {r['roi_first_half']:+.2%} / "
              f"{r['roi_second_half']:+.2%} p {r['p']:.4f} -> {'PASS' if r['passes'] else 'FAIL'}")
