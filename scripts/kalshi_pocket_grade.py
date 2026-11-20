"""Pipeline step (overnight, after kalshi_settle): grade open paper trades from kalshi_markets results."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from kalshi_edges import sb  # noqa: E402
from kalshi_edges.pockets_live import grade_updates  # noqa: E402

if __name__ == '__main__':
    load_env_local()
    open_trades = sb.select_all("kalshi_pocket_trades", "select=id,ticker,side,price,fee&result=is.null&order=id")
    tickers = sorted({t["ticker"] for t in open_trades})
    results = {}
    for i in range(0, len(tickers), 100):
        ids = ",".join(f'"{t}"' for t in tickers[i:i + 100])
        for r in sb.select_all("kalshi_markets", f"select=ticker,result&ticker=in.({ids})&result=not.is.null&order=ticker"):
            results[r["ticker"]] = r["result"]
    ups = grade_updates(open_trades, results)
    for u in ups:
        sb.patch("kalshi_pocket_trades", f"id=eq.{u['id']}", {k: v for k, v in u.items() if k != "id"})
    print(f"kalshi_pocket_grade: {len(open_trades)} open, {len(ups)} graded")
