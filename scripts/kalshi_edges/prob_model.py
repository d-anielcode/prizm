"""Parametric P(stat >= strike) engine for the Kalshi edge finder.

Pure functions, no I/O. See the design spec for the calibrated mean-shift bridge.
"""
from __future__ import annotations
import math
from dataclasses import dataclass
from statistics import mean, pvariance

from scipy import stats
from scipy.optimize import brentq

# Canonical stat_type -> player_game_logs column key.
STAT_LOG_KEY = {
    "points": "points", "rebounds": "rebounds", "assists": "assists",
    "pra": "pra", "steals": "steals", "blocks": "blocks",
    "three_pointers": "fg3m",
}
# Normal family stats; everything else in STAT_LOG_KEY is modeled as a count.
NORMAL_STATS = {"points", "pra"}
MIN_MINUTES = 5
MIN_GAMES = 10

def stat_values(logs, stat):
    """Per-game values for `stat`, dropping games under MIN_MINUTES or with a null value."""
    key = STAT_LOG_KEY[stat]
    out = []
    for g in logs:
        if (g.get("minutes") or 0) < MIN_MINUTES:
            continue
        v = g.get(key)
        if v is None:
            continue
        out.append(float(v))
    return out

@dataclass
class Distribution:
    family: str          # "normal" | "nbinom" | "poisson"
    mu0: float           # baseline mean from logs
    sigma: float         # std (used by normal; informational for counts)
    r: float | None      # negative-binomial size param (None otherwise)

def fit_distribution(logs, stat):
    """Fit a stat distribution to game logs via method-of-moments.

    Raises ValueError when fewer than MIN_GAMES qualifying games exist.
    """
    vals = stat_values(logs, stat)
    if len(vals) < MIN_GAMES:
        raise ValueError(f"insufficient games: {len(vals)} < {MIN_GAMES}")
    mu0 = mean(vals)
    var = pvariance(vals) if len(vals) > 1 else mu0
    if stat in NORMAL_STATS:
        return Distribution("normal", mu0, max(math.sqrt(var), 1e-6), None)
    if mu0 <= 0 or var <= mu0:               # degenerate or not overdispersed
        m = max(mu0, 1e-6)
        return Distribution("poisson", m, math.sqrt(m), None)
    r = mu0 * mu0 / (var - mu0)              # NB size from moments
    return Distribution("nbinom", mu0, math.sqrt(var), r)

def _sf_at(dist, mu, x):
    """P(X > x) for `dist` shifted to mean `mu`. x may be fractional.

    Normal family: sigma is held fixed across the mean shift (the design is an
    additive mean shift, not a location-scale change). A continuity correction
    of +0.5 is applied only when x is an INTEGER threshold; sportsbook .5 lines
    get none. So `prob_over_line(dist, mu, 25)` returns P(X > 25.5), not the
    strict continuous P(X > 25) -- callers wanting the strict value must pass a
    fractional x. `prob_at_strike` relies on this: it passes integer strike-1 so
    P(X >= strike) is continuity-corrected.
    """
    if dist.family == "normal":
        bump = 0.5 if float(x).is_integer() else 0.0
        return float(stats.norm.sf((x + bump - mu) / dist.sigma))
    if dist.family == "poisson":
        return float(stats.poisson.sf(math.floor(x), max(mu, 1e-9)))
    r = dist.r
    p = r / (r + max(mu, 1e-9))
    return float(stats.nbinom.sf(math.floor(x), r, p))

def prob_over_line(dist, mu, line):
    """P(X > line) at mean `mu`. For sportsbook .5 lines this is unambiguous."""
    return _sf_at(dist, mu, line)

def prob_at_strike(dist, delta, strike):
    """P(X >= strike) at shifted mean mu0+delta. `strike` is an integer milestone."""
    return _sf_at(dist, dist.mu0 + delta, strike - 1)

def solve_shift(dist, book_line, target_p, max_shift=None):
    """Find delta so P(X > book_line | mu0+delta) == target_p.

    Returns (delta, clamped). Clamps to the search bound (and flags it) when the
    target probability is unreachable within +/- max_shift.
    """
    if max_shift is None:
        # Always bracket the book line plus tail room. A flat 4*sigma window can
        # be too narrow for overdispersed NB fits (variance grows superlinearly
        # with the shifted mean), producing false `clamped` returns when the
        # target is actually reachable.
        max_shift = abs(book_line - dist.mu0) + 4.0 * dist.sigma
    target_p = min(max(target_p, 1e-6), 1 - 1e-6)
    f = lambda d: prob_over_line(dist, dist.mu0 + d, book_line) - target_p
    lo, hi = -max_shift, max_shift
    flo, fhi = f(lo), f(hi)
    if flo == 0.0:
        return (lo, False)
    if fhi == 0.0:
        return (hi, False)
    if (flo > 0) == (fhi > 0):                 # no sign change -> unreachable
        return (hi, True) if abs(fhi) < abs(flo) else (lo, True)
    return (float(brentq(f, lo, hi, xtol=1e-4)), False)
