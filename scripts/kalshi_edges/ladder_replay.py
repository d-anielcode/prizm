"""Full-ladder replay on 2025-26 (spec 2026-11-11). Pure functions.

Discovery only: the calibration table overlaps this season. The bar below is fixed by the
spec; do not change filters or bars after seeing results."""
from collections import defaultdict
from dataclasses import dataclass

from kalshi_edges.fees import taker_fee
from kalshi_edges.find_edges import normalize_name
from kalshi_edges.ladder_model import LADDER_STATS, ladder_probs
from kalshi_edges.study import pocket_stats

SEASON = "2025-26"
LATEST_START = "2025-11-25"
MIN_N, MIN_ROI, ALPHA = 300, 0.03, 0.05
# Mirror of lib/kalshi/model-picks.ts matchStretched filters.
MIN_PRICE, MAX_PRICE, MAX_SPREAD_CENTS, MAX_GAP = 0.05, 0.95, 10, 0.10


def _r4(x):
    return None if x is None else round(float(x), 4)


def pick_side(model_p, bid, ask):
    """(side, price, fee, edge) for the better qualifying side, or None."""
    if bid is None or ask is None or bid <= 0 or ask <= 0:
        return None
    if round((ask - bid) * 100) > MAX_SPREAD_CENTS:
        return None
    best = None
    for side, price, p in (("yes", _r4(ask), model_p), ("no", _r4(1 - bid), 1 - model_p)):
        if price < MIN_PRICE or price > MAX_PRICE:
            continue
        fee = taker_fee(price)
        edge = p - (price + fee)
        if not (0 < edge <= MAX_GAP):
            continue
        if best is None or edge > best[3]:
            best = (side, price, fee, edge)
    return best


@dataclass
class Trade:
    ticker: str
    game_date: str
    stat: str
    distance: float    # strike - (anchor_line + 0.5), in stat units
    side: str
    price: float
    fee: float
    model_p: float
    won: bool
    pnl: float


def replay(settled, grades, logs, calib):
    """{trades, evals, skips} over settled 2025-26 ladder rungs (non-void, ladder stats).
    grades: prop_grades rows (game_date, player_name, stat_type, line, direction, confidence_score).
    evals: every priced non-exact rung with a two-sided book (for Brier/calibration)."""
    ladders = defaultdict(list)
    for r in settled:
        if r.get("season") == SEASON and r["stat"] in LADDER_STATS and r.get("result") in ("yes", "no"):
            ladders[(str(r["game_date"])[:10], normalize_name(r["player"]), r["stat"])].append(r)
    g_idx = defaultdict(list)
    for g in grades:
        g_idx[(str(g["game_date"])[:10], normalize_name(g["player_name"]), g["stat_type"])].append(g)
    log_idx = defaultdict(list)
    for g in logs:
        log_idx[normalize_name(g["player_name"])].append(g)

    trades, evals, skips = [], [], defaultdict(int)
    for (day, name, stat), rungs in sorted(ladders.items()):
        res, why = ladder_probs(g_idx.get((day, name, stat), []), log_idx.get(name, []), stat,
                                sorted({int(r["strike"]) for r in rungs}), day, calib)
        if res is None:
            skips[why] += 1
            continue
        for r in rungs:
            s = int(r["strike"])
            if res["exact"][s]:
                continue
            p = res["probs"][s]
            y = 1 if r["result"] == "yes" else 0
            bid, ask = _r4(r.get("pretip_yes_bid")), _r4(r.get("pretip_yes_ask"))
            if bid is not None and ask is not None:
                evals.append({"model_p": p, "mid": (bid + ask) / 2, "y": y, "stat": stat, "strike": s})
            pick = pick_side(p, bid, ask)
            if pick is None:
                continue
            side, price, fee, _ = pick
            won = (side == "yes") == (y == 1)
            trades.append(Trade(ticker=r["ticker"], game_date=day, stat=stat,
                                distance=s - (res["anchor_line"] + 0.5), side=side, price=price, fee=fee,
                                model_p=p if side == "yes" else 1 - p, won=won,
                                pnl=(1 - price - fee) if won else -(price + fee)))
    return {"trades": trades, "evals": evals, "skips": dict(skips)}


def verdict(trades):
    """Pre-registered bar: n >= 300, ROI >= +3%, both halves > 0, day-clustered one-sided p < 0.05."""
    s = pocket_stats(trades) if trades else {"n": 0, "roi": 0.0, "roi_h1": 0.0, "roi_h2": 0.0, "p": 1.0}
    s["pass"] = bool(s["n"] >= MIN_N and s["roi"] >= MIN_ROI and s["roi_h1"] > 0
                     and s["roi_h2"] > 0 and s["p"] < ALPHA)
    return s


def replay_complete(rows):
    """(ok, reason): 2025-26 settled rows cover all ladder stats and start early enough."""
    disc = [r for r in rows if r.get("season") == SEASON]
    missing = [s for s in LADDER_STATS if s not in {r["stat"] for r in disc}]
    if missing:
        return False, f"{SEASON} rows missing stats: {', '.join(missing)}"
    earliest = min(str(r["game_date"])[:10] for r in disc)
    if earliest > LATEST_START:
        return False, f"earliest {SEASON} game_date is {earliest} (> {LATEST_START})"
    return True, ""


def brier(evals):
    if not evals:
        return {"n": 0, "model": None, "market": None}
    n = len(evals)
    return {"n": n, "model": sum((e["model_p"] - e["y"]) ** 2 for e in evals) / n,
            "market": sum((e["mid"] - e["y"]) ** 2 for e in evals) / n}


def calibration_bins(evals):
    """Model_p deciles: n, mean model_p, realized YES rate (non-empty bins only)."""
    bins = defaultdict(list)
    for e in evals:
        k = min(int(e["model_p"] * 10), 9)
        bins[k].append(e)
    return [{"bin": f"{k / 10:.1f}-{(k + 1) / 10:.1f}", "n": len(es),
             "mean_p": sum(e["model_p"] for e in es) / len(es),
             "yes_rate": sum(e["y"] for e in es) / len(es)} for k, es in sorted(bins.items())]


def _group(trades, key):
    groups = defaultdict(list)
    for t in trades:
        groups[key(t)].append(t)
    return [{"key": k, **verdict(ts)} for k, ts in sorted(groups.items())]


def _dist_bucket(d):
    a = abs(d)
    return "1 step" if a <= 2 else "2 steps" if a <= 5 else "3+ steps"


def summarize(out, n_settled):
    trades = out["trades"]
    return {"verdict": verdict(trades), "by_stat": _group(trades, lambda t: t.stat),
            "by_distance": _group(trades, lambda t: _dist_bucket(t.distance)),
            "brier": brier(out["evals"]), "calibration": calibration_bins(out["evals"]),
            "skips": out["skips"], "n_settled": n_settled}


def _pct(x):
    return "—" if x is None else f"{x * 100:+.1f}%"


def render_report(s):
    v = s["verdict"]
    lines = [
        "# Kalshi full-ladder replay (2025-26, discovery)", "",
        "Spec: `docs/superpowers/specs/2026-11-11-kalshi-full-ladder-design.md`.",
        "Calibration table overlaps this season, so this is discovery only; the forward",
        "2026-27 record is the real test.", "",
        f"**Result: {'PASS' if v['pass'] else 'FAIL'}** — n={v['n']}, ROI {_pct(v['roi'])}, "
        f"halves {_pct(v['roi_h1'])} / {_pct(v['roi_h2'])}, p={v['p']:.4f} "
        f"(bar: n>=300, ROI>=+3%, both halves >0, p<0.05).", "",
        f"Settled ladder rungs read: {s['n_settled']}. Ladders skipped: {s['skips'] or 'none'}.", "",
        "## By stat (reported, not gated)", "", "| stat | n | ROI | p |", "|---|---|---|---|",
        *[f"| {g['key']} | {g['n']} | {_pct(g['roi'])} | {g['p']:.3f} |" for g in s["by_stat"]], "",
        "## By distance from the book line (reported, not gated)", "", "| distance | n | ROI | p |", "|---|---|---|---|",
        *[f"| {g['key']} | {g['n']} | {_pct(g['roi'])} | {g['p']:.3f} |" for g in s["by_distance"]], "",
        "## Brier (non-exact rungs with a two-sided book)", "",
    ]
    b = s["brier"]
    lines.append("No rungs." if not b["n"] else
                 f"n={b['n']}: model {b['model']:.4f} vs Kalshi mid {b['market']:.4f} (lower is better).")
    lines += ["", "## Calibration of model_p", "", "| bin | n | mean model_p | YES rate |", "|---|---|---|---|",
              *[f"| {c['bin']} | {c['n']} | {c['mean_p']:.3f} | {c['yes_rate']:.3f} |" for c in s["calibration"]], ""]
    return "\n".join(lines)
