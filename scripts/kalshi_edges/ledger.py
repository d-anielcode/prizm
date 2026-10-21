"""Paper-trade ledger: pure grading/report math + Supabase I/O (below)."""
from collections import defaultdict

# Pre-registered go-live bar (spec). Do not tune after seeing results.
BAR = {"min_n": 300, "min_roi": 0.03}

def grade(side, price, fee, result):
    """(won, pnl per contract). result is Kalshi's 'yes'/'no'; anything else = void."""
    if result not in ("yes", "no"):
        return None, 0.0
    won = result == side
    return won, (1.0 - price - fee) if won else -(price + fee)

def side_mid(side, yes_bid, yes_ask):
    mid = (yes_bid + yes_ask) / 2.0
    return mid if side == "yes" else 1.0 - mid

def _roi(rows):
    """P&L per dollar risked (price + fee per contract)."""
    staked = sum(r["price"] + r["fee"] for r in rows)
    return sum(r["pnl"] for r in rows) / staked if staked else 0.0

def report(rows):
    graded = sorted([r for r in rows if r.get("won") is not None], key=lambda r: r["scan_date"])
    n = len(graded)
    half = n // 2
    clvs = [r["clv_mid"] - r["price"] for r in graded if r.get("clv_mid") is not None]
    by = defaultdict(list)
    for r in graded:
        by[(r["stat_type"], r["side"])].append(r)
    rep = {
        "n": n,
        "win_rate": sum(r["won"] for r in graded) / n if n else 0.0,
        "roi": _roi(graded),
        "roi_first_half": _roi(graded[:half]),
        "roi_second_half": _roi(graded[half:]),
        "mean_clv": sum(clvs) / len(clvs) if clvs else 0.0,
        "n_clv": len(clvs),
        "by_stat_side": {f"{s}:{d}": (len(v), round(_roi(v), 4)) for (s, d), v in sorted(by.items())},
    }
    rep["passes_bar"] = (n >= BAR["min_n"] and rep["roi"] >= BAR["min_roi"]
                         and rep["roi_first_half"] > 0 and rep["roi_second_half"] > 0
                         and rep["mean_clv"] > 0)
    return rep
