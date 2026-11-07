"""Forward paper trading of confirmed/live pockets (spec 2026-11-07)."""
from datetime import timedelta

from kalshi_edges.study import build_trades, classify
from kalshi_edges.teams import ticker_teams

WINDOW = timedelta(minutes=45)
ACTIVE_STATUSES = ("confirmed", "live")


def scan_trades(market_rows, tips, now, active):
    """market_rows: today's kalshi_markets rows; tips: {ticker team string: tip dt};
    active: pocket ids to trade. Returns kalshi_pocket_trades rows (unsettled).
    Ladder position is computed over rows of games tipping soon only (same game ->
    same ladder), matching the study's per-game ladders."""
    soon = [r for r in market_rows
            if (tip := tips.get(ticker_teams(r["ticker"]))) is not None and now < tip <= now + WINDOW]
    mapped = [{"ticker": r["ticker"], "player": r["player"], "stat": r["stat"], "strike": r["strike"],
               "game_date": r["game_date"], "pretip_yes_bid": r.get("yes_bid"),
               "pretip_yes_ask": r.get("yes_ask"), "pretip_volume": r.get("volume"), "result": None}
              for r in soon]
    out = []
    for t in build_trades(mapped, require_result=False):
        for pid in classify(t):
            if pid in active:
                out.append({"pocket_id": pid, "ticker": t.ticker, "side": t.side, "price": round(t.price, 4),
                            "fee": round(t.fee, 6), "game_date": t.game_date})
    return out


def grade_updates(open_trades, results):
    """results: {ticker: 'yes'|'no'|'void'} from kalshi_markets. Ungraded tickers are skipped."""
    out = []
    for t in open_trades:
        res = results.get(t["ticker"])
        if res == "void":
            out.append({"id": t["id"], "result": "void", "won": None, "pnl": 0.0})
        elif res in ("yes", "no"):
            won = res == t["side"]
            price, fee = float(t["price"]), float(t["fee"])
            out.append({"id": t["id"], "result": res, "won": won, "pnl": (1 - price - fee) if won else -(price + fee)})
    return out
