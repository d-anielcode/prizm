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
