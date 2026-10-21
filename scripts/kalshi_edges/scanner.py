"""Kalshi rung vs book fair value: P(yes) via the mean-shift bridge, edge after fee."""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from kalshi_edges import prob_model
from kalshi_edges.fees import taker_fee
from kalshi_edges.find_edges import normalize_name

RECENT_GAMES = 40  # distribution shape from the player's most recent games

@dataclass
class Filters:
    min_edge: float = 0.03
    max_spread: float = 0.10
    min_p: float = 0.10
    max_p: float = 0.90
    # Kalshi "N+" vs book "over N-0.5" is the at-line rung; allow this many rungs away.
    # Far rungs depend on the per-player distribution's width, which proved noisy
    # (live dry run 2026-10-21: tails on both sides flagged), so keep it tight.
    max_rungs: float = 1.0
    # One-sided fair values (no over/under pair at one line) are too rough to trade.
    require_two_sided: bool = True

@dataclass
class Candidate:
    market_ticker: str
    series: str
    player_name: str
    stat_type: str
    strike: int
    side: str
    price: float
    fee: float
    fair_p: float
    edge: float
    yes_bid: float
    yes_ask: float
    volume: int
    book_line: float
    book_p_over: float
    devig: str
    books: str
    commence_time: str | None

def _started(commence_time, now):
    if not commence_time:
        return False
    return datetime.fromisoformat(commence_time.replace("Z", "+00:00")) <= now

def evaluate_rung(kp, fair, dist, fee_mult, now, f):
    """Best side (yes/no) for one rung, or None if any filter fails."""
    if _started(fair.commence_time, now):
        return None
    if kp.yes_ask - kp.yes_bid > f.max_spread:
        return None
    if f.require_two_sided and fair.devig != "two_sided":
        return None
    if abs(kp.strike - (fair.line + 0.5)) > f.max_rungs:
        return None
    delta, clamped = prob_model.solve_shift(dist, fair.line, fair.p_over)
    if clamped:
        return None
    p_yes = prob_model.prob_at_strike(dist, delta, kp.strike)
    if not f.min_p <= p_yes <= f.max_p:
        return None
    options = [("yes", p_yes, kp.yes_ask)]
    if kp.yes_bid > 0:
        options.append(("no", 1.0 - p_yes, 1.0 - kp.yes_bid))
    best = None
    for side, p, price in options:
        fee = taker_fee(price, fee_mult)
        edge = p - price - fee
        if best is None or edge > best[3]:
            best = (side, p, price, edge, fee)
    side, p, price, edge, fee = best
    if edge < f.min_edge:
        return None
    return Candidate(kp.ticker, kp.series, fair.player_name, kp.stat, kp.strike, side,
                     round(price, 4), round(fee, 4), round(p, 4), round(edge, 4),
                     kp.yes_bid, kp.yes_ask, kp.volume, fair.line, round(fair.p_over, 4),
                     fair.devig, fair.books, fair.commence_time)

def scan(kalshi_props, fair_index, logs_by_player, fee_mults, now, f=None):
    """Return (candidates sorted by edge desc, Counter of skip reasons).
    logs_by_player lists must be most-recent-first."""
    f = f or Filters()
    out, skipped, dists = [], Counter(), {}
    for kp in kalshi_props:
        name = normalize_name(kp.player)
        fair = fair_index.get((name, kp.stat))
        if fair is None:
            skipped["no_book_line"] += 1
            continue
        key = (name, kp.stat)
        if key not in dists:
            try:
                dists[key] = prob_model.fit_distribution(logs_by_player.get(name, [])[:RECENT_GAMES], kp.stat)
            except ValueError:
                dists[key] = None
        if dists[key] is None:
            skipped["few_logs"] += 1
            continue
        c = evaluate_rung(kp, fair, dists[key], fee_mults.get(kp.series, 1.0), now, f)
        if c is None:
            skipped["filtered"] += 1
            continue
        out.append(c)
    out.sort(key=lambda c: c.edge, reverse=True)
    return out, skipped
