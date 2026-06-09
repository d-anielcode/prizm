"""Parametric P(stat >= strike) engine for the Kalshi edge finder.

Pure functions, no I/O. See the design spec for the calibrated mean-shift bridge.
"""
from __future__ import annotations
from dataclasses import dataclass

# Canonical stat_type -> player_game_logs column key.
STAT_LOG_KEY = {
    "points": "points", "rebounds": "rebounds", "assists": "assists",
    "pra": "pra", "steals": "steals", "blocks": "blocks",
    "three_pointers": "fg3m",
}
COUNT_STATS = {"rebounds", "assists", "three_pointers", "steals", "blocks"}
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

import math
from statistics import mean, pvariance

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
