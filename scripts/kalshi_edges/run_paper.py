r"""Kalshi paper trading: scan | clv | grade | report.

Run from repo `scripts/`:  python3 -m kalshi_edges.run_paper scan --dry-run
Scheduled on the user's PC via pythonw.exe (see README). Loads .env.local itself and
appends to .logs\kalshi-paper.log.
"""
import argparse
import logging
import os
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _load_env():
    path = os.path.join(REPO, ".env.local")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()  # before importing modules that read env at import time

from kalshi_edges import market_data, prizm_data, ledger  # noqa: E402
from kalshi_edges.fair_value import fair_lines  # noqa: E402
from kalshi_edges.fees import fetch_fee_multiplier  # noqa: E402
from kalshi_edges.find_edges import normalize_name  # noqa: E402
from kalshi_edges.scanner import Filters, scan  # noqa: E402

ET = ZoneInfo("America/New_York")
log = logging.getLogger("kalshi_paper")


def _setup_logging():
    os.makedirs(os.path.join(REPO, ".logs"), exist_ok=True)
    handlers = [logging.FileHandler(os.path.join(REPO, ".logs", "kalshi-paper.log"), encoding="utf-8")]
    if sys.stdout is not None:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)


def cmd_scan(args):
    now = datetime.now(timezone.utc)
    game_date = args.game_date or now.astimezone(ET).date().isoformat()
    props = prizm_data.slate_with_odds(game_date)
    fair, _ = fair_lines(props)
    by_player = defaultdict(list)
    for g in prizm_data.all_logs():  # most recent first
        by_player[normalize_name(g["player_name"])].append(g)
    kalshi = [k for k in market_data.fetch_props() if k.game_date and k.game_date.isoformat() == game_date]
    fee_mults = {s: fetch_fee_multiplier(s) for s in market_data.PROP_SERIES}
    cands, skipped = scan(kalshi, fair, by_player, fee_mults, now, Filters(min_edge=args.min_edge))
    log.info("scan %s: %d book lines, %d Kalshi rungs, %d candidates, skipped %s",
             game_date, len(fair), len(kalshi), len(cands), dict(skipped))
    for c in cands[:40]:
        log.info("  %-24s %-14s %3d+ %-3s price %.2f fair %.3f edge %+.3f (%s)",
                 c.player_name, c.stat_type, c.strike, c.side, c.price, c.fair_p, c.edge, c.devig)
    if args.dry_run:
        log.info("dry run: nothing written")
        return 0
    log.info("inserted %d paper trades", ledger.insert_candidates(cands, game_date))
    return 0


def cmd_clv(_args):
    now = datetime.now(timezone.utc)
    rows = ledger.rows_needing_clv(now)
    for r in rows:
        m = market_data.fetch_market(r["market_ticker"])
        bid, ask = float(m.get("yes_bid_dollars") or 0), float(m.get("yes_ask_dollars") or 0)
        if ask <= 0:
            continue
        ledger.update_row(r["id"], {"clv_mid": round(ledger.side_mid(r["side"], bid, ask), 4)})
    log.info("clv: updated %d rows", len(rows))
    return 0


def cmd_grade(_args):
    now = datetime.now(timezone.utc)
    done = 0
    for r in ledger.rows_needing_grade(now):
        m = market_data.fetch_market(r["market_ticker"])
        if m.get("status") not in ("finalized", "settled"):
            continue
        won, pnl = ledger.grade(r["side"], float(r["price"]), float(r["fee"]), m.get("result"))
        ledger.update_row(r["id"], {"result": m.get("result"), "won": won, "pnl": round(pnl, 4),
                                    "graded_at": now.isoformat()})
        done += 1
    log.info("grade: graded %d rows", done)
    return 0


def cmd_report(_args):
    rows = ledger.fetch_rows("select=*")
    for r in rows:
        for k in ("price", "fee", "pnl", "clv_mid"):
            if r.get(k) is not None:
                r[k] = float(r[k])
    rep = ledger.report(rows)
    log.info("report: %s", rep)
    log.info("go-live bar (n>=%d, ROI>=%.0f%%, both halves >0, CLV>0): %s",
             ledger.BAR["min_n"], ledger.BAR["min_roi"] * 100, "PASS" if rep["passes_bar"] else "not met")
    return 0


def main(argv=None):
    _setup_logging()
    ap = argparse.ArgumentParser(description="Kalshi paper trading")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--game-date")
    s.add_argument("--min-edge", type=float, default=0.03)
    sub.add_parser("clv")
    sub.add_parser("grade")
    sub.add_parser("report")
    args = ap.parse_args(argv)
    from pipeline.store import safe_store  # job_runs logging; never blocks the command
    store = safe_store()
    rid = store.start(str(uuid.uuid4()), "pc", f"kalshi:{args.cmd}",
                      datetime.now(ET).date().isoformat(), source="pc") if store else None
    try:
        code = {"scan": cmd_scan, "clv": cmd_clv, "grade": cmd_grade, "report": cmd_report}[args.cmd](args)
        error = None if code == 0 else f"exit {code}"
    except Exception as e:
        log.exception("%s failed", args.cmd)
        code, error = 1, f"{type(e).__name__}: {e}"
    if store:
        store.finish(rid, status="ok" if code == 0 else "failed",
                     finished_at=datetime.now(timezone.utc).isoformat(), error=error)
    return code


if __name__ == "__main__":
    sys.exit(main())
