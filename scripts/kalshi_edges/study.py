"""Pre-registered Kalshi calibration study (spec 2026-11-07). Pure functions.

Pockets, bands and bars are fixed by the spec; do not edit after seeing results.
"""
from collections import defaultdict
from dataclasses import dataclass

from scipy import stats as sstats

from kalshi_edges.fees import taker_fee

BANDS = [(.02, .05), (.05, .10), (.10, .20), (.20, .35), (.35, .50), (.50, .65), (.65, .80), (.80, .90), (.90, .98)]
BAND_LABELS = [f"{lo:.2f}-{hi:.2f}".replace("0.", ".") for lo, hi in BANDS]
STATS = ["points", "rebounds", "assists", "three_pointers", "pra", "double_double", "triple_double"]
POSITIONS = ["lowest", "interior", "top"]
SPREADS = ["<=3", "4-10", ">10"]
VOLUMES = ["0", "1-99", "100+"]
SIDES = ["yes", "no"]
SINGLE_RUNG = {"double_double", "triple_double"}

POCKET_IDS = (
    [f"{s}|band:{b}" for s in SIDES for b in BAND_LABELS]
    + [f"{s}|stat:{x}" for s in SIDES for x in STATS]
    + [f"{s}|pos:{x}" for s in SIDES for x in POSITIONS]
    + [f"{s}|spread:{x}" for s in SIDES for x in SPREADS]
    + [f"{s}|vol:{x}" for s in SIDES for x in VOLUMES]
    + [f"{s}|band:{b}|stat:{x}" for s in SIDES for b in BAND_LABELS for x in STATS]
)
K = len(POCKET_IDS)
ALPHA = 0.05 / 176

DISC_MIN_N, DISC_MIN_ROI = 300, 0.03
CONF_MIN_N = 100
FWD_MIN_N, FWD_MIN_ROI = 300, 0.03

PRICE_DP = 4   # Kalshi prices are cent-granular; rounding removes float noise like 1 - 0.9


def band_of(p):
    for (lo, hi), label in zip(BANDS, BAND_LABELS):
        if lo <= p < hi or (hi == .98 and p == .98):
            return label
    return None


@dataclass
class Trade:
    ticker: str
    game_date: str
    season: str
    side: str
    price: float
    fee: float
    won: bool | None
    pnl: float | None
    stat: str
    pos: str
    spread: str
    vol: str


def _f(v):
    return None if v is None else float(v)


def _price(v):
    return None if v is None else round(float(v), PRICE_DP)


def _positions(rows):
    ladders = defaultdict(list)
    for r in rows:
        ladders[(r["game_date"], r["player"], r["stat"])].append(int(r["strike"]))
    pos = {}
    for r in rows:
        strikes = ladders[(r["game_date"], r["player"], r["stat"])]
        s = int(r["strike"])
        if r["stat"] in SINGLE_RUNG or len(strikes) == 1 or s == min(strikes):
            pos[r["ticker"]] = "lowest"
        elif s == max(strikes):
            pos[r["ticker"]] = "top"
        else:
            pos[r["ticker"]] = "interior"
    return pos


def _spread_tier(bid, ask):
    if bid is None or ask is None:
        return ">10"
    c = round((ask - bid) * 100)
    return "<=3" if c <= 3 else "4-10" if c <= 10 else ">10"


def _vol_tier(v):
    v = v or 0
    return "0" if v <= 0 else "1-99" if v < 100 else "100+"


def build_trades(rows, require_result=True):
    """One trade per priced side. Rows use kalshi_settled column names (live scans map
    kalshi_markets onto them). With require_result=False, unsettled rows give won/pnl None.
    Prices are rounded to PRICE_DP decimals before banding so 1 - bid never lands a
    hair below a band edge."""
    rows = [r for r in rows if r.get("result") != "void"]
    pos = _positions([r for r in rows if r.get("pretip_yes_ask") is not None or r.get("pretip_yes_bid") is not None])
    out = []
    for r in rows:
        res = r.get("result")
        if require_result and res not in ("yes", "no"):
            continue
        bid, ask = _price(r.get("pretip_yes_bid")), _price(r.get("pretip_yes_ask"))
        common = dict(ticker=r["ticker"], game_date=str(r["game_date"]), season=r.get("season", ""),
                      stat=r["stat"], pos=pos.get(r["ticker"], "lowest"),
                      spread=_spread_tier(bid, ask), vol=_vol_tier(_f(r.get("pretip_volume"))))
        for side, price in (("yes", ask), ("no", None if bid is None else round(1 - bid, PRICE_DP))):
            if price is None or band_of(price) is None:
                continue
            fee = taker_fee(price)
            won = None if res not in ("yes", "no") else (res == side)
            pnl = None if won is None else (1 - price - fee if won else -(price + fee))
            out.append(Trade(side=side, price=price, fee=fee, won=won, pnl=pnl, **common))
    return out


def classify(t):
    b = band_of(t.price)
    return [f"{t.side}|band:{b}", f"{t.side}|stat:{t.stat}", f"{t.side}|pos:{t.pos}",
            f"{t.side}|spread:{t.spread}", f"{t.side}|vol:{t.vol}", f"{t.side}|band:{b}|stat:{t.stat}"]


def _roi(ts):
    staked = sum(t.price + t.fee for t in ts)
    return sum(t.pnl for t in ts) / staked if staked else 0.0


def pocket_stats(trades):
    ts = sorted(trades, key=lambda t: (t.game_date, t.ticker, t.side))
    n = len(ts)
    days = defaultdict(float)
    for t in ts:
        days[t.game_date] += t.pnl
    daily = list(days.values())
    if len(daily) >= 2 and len(set(daily)) > 1:
        p = float(sstats.ttest_1samp(daily, 0.0, alternative="greater").pvalue)
    elif len(daily) >= 2 and daily[0] > 0:
        p = 0.0
    else:
        p = 1.0
    return {"n": n, "roi": _roi(ts), "roi_h1": _roi(ts[: n // 2]), "roi_h2": _roi(ts[n // 2:]), "p": p}


def discovery_pass(d):
    return (d["n"] >= DISC_MIN_N and d["roi"] >= DISC_MIN_ROI and d["roi_h1"] > 0
            and d["roi_h2"] > 0 and d["p"] < ALPHA)


def status_of(disc, conf, fwd):
    if not discovery_pass(disc):
        return "rejected"
    if conf["n"] < CONF_MIN_N:
        return "discovery_pass"
    if conf["roi"] < 0:
        return "failed_confirmation"
    if fwd["n"] >= FWD_MIN_N:
        return "live" if fwd["roi"] >= FWD_MIN_ROI else "failed_forward"
    return "confirmed"


def by_pocket(trades):
    out = defaultdict(list)
    for t in trades:
        for pid in classify(t):
            out[pid].append(t)
    return out


def calibration(rows):
    acc = defaultdict(lambda: [0, 0.0, 0])
    for r in rows:
        ask = _price(r.get("pretip_yes_ask"))
        if ask is None or r.get("result") not in ("yes", "no"):
            continue
        b = band_of(ask)
        if b is None:
            continue
        a = acc[(r["season"], b)]
        a[0] += 1; a[1] += ask; a[2] += r["result"] == "yes"
    return [{"season": s, "band": b, "n": n, "mean_ask": tot / n, "yes_rate": y / n}
            for (s, b), (n, tot, y) in sorted(acc.items())]


def definition(pid):
    parts = pid.split("|")
    return {"side": parts[0], **{k: v for k, v in (p.split(":", 1) for p in parts[1:])}}


def _summary(ts):
    return pocket_stats(ts) if ts else {"n": 0, "roi": 0.0, "roi_h1": 0.0, "roi_h2": 0.0, "p": 1.0}


def evaluate(rows, forward_trades):
    """rows: kalshi_settled rows; forward_trades: graded kalshi_pocket_trades (won not null).
    Returns one kalshi_pockets row per pre-registered pocket."""
    trades = build_trades(rows)
    disc = by_pocket([t for t in trades if t.season == "2025-26"])
    conf = by_pocket([t for t in trades if t.season != "2025-26"])
    fwd = defaultdict(list)
    for f in forward_trades:
        if f.get("won") is not None:
            fwd[f["pocket_id"]].append(f)
    out = []
    for pid in POCKET_IDS:
        d, c = _summary(disc.get(pid, [])), _summary(conf.get(pid, []))
        fl = fwd.get(pid, [])
        staked = sum(float(f["price"]) + float(f["fee"]) for f in fl)
        fw = {"n": len(fl), "roi": (sum(float(f["pnl"]) for f in fl) / staked) if staked else 0.0}
        out.append({"id": pid, "side": pid.split("|")[0], "definition": definition(pid),
                    "disc_n": d["n"], "disc_roi": round(d["roi"], 5), "disc_roi_h1": round(d["roi_h1"], 5),
                    "disc_roi_h2": round(d["roi_h2"], 5), "disc_p": d["p"],
                    "conf_n": c["n"], "conf_roi": round(c["roi"], 5),
                    "fwd_n": fw["n"], "fwd_roi": round(fw["roi"], 5),
                    "status": status_of(d, c, fw)})
    return out


def render_report(pockets, cal, n_rows):
    passed = [p for p in pockets if p["status"] != "rejected"]
    lines = ["# Kalshi calibration study", "",
             f"{n_rows} settled markets; {len(pockets)} pockets tested (pre-registered, K={K}, "
             f"alpha {ALPHA:.2e}); {len(passed)} passed discovery.", "",
             "## Calibration (YES ask band vs realized YES rate)", "",
             "| season | band | n | mean ask | YES rate |", "|---|---|---|---|---|"]
    lines += [f"| {c['season']} | {c['band']} | {c['n']} | {c['mean_ask']:.3f} | {c['yes_rate']:.3f} |" for c in cal]
    lines += ["", "## Pockets that passed discovery", ""]
    if passed:
        lines += ["| pocket | disc n | disc ROI | p | conf n | conf ROI | status |", "|---|---|---|---|---|---|---|"]
        lines += [f"| {p['id']} | {p['disc_n']} | {p['disc_roi']:+.1%} | {p['disc_p']:.1e} | {p['conf_n']} | "
                  f"{p['conf_roi']:+.1%} | {p['status']} |" for p in passed]
    else:
        lines.append("None.")
    best = sorted(pockets, key=lambda p: -p["disc_roi"])[:15]
    lines += ["", "## Top 15 pockets by discovery ROI (for context; bars decide)", "",
              "| pocket | disc n | disc ROI | h1 | h2 | p | status |", "|---|---|---|---|---|---|---|"]
    lines += [f"| {p['id']} | {p['disc_n']} | {p['disc_roi']:+.1%} | {p['disc_roi_h1']:+.1%} | "
              f"{p['disc_roi_h2']:+.1%} | {p['disc_p']:.1e} | {p['status']} |" for p in best]
    return "\n".join(lines) + "\n"
