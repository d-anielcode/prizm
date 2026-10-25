"""Hand-crafted log fixtures used across factor tests.

Each fixture represents a player's recent game logs in descending date order
(most recent first), matching the format used by lib/confidence.ts.
"""
from typing import List, Dict, Any

def basic_pts_logs() -> List[Dict[str, Any]]:
    """20 games, average ~25 pts, no obvious trend."""
    return [
        {"game_date": f"2026-05-{20-i:02d}", "minutes": 32, "points": 25,
         "rebounds": 8, "assists": 6, "fg3m": 2, "blocks": 1, "steals": 1,
         "pra": 39, "is_home": i % 2 == 0,
         "matchup": "LAL @ BOS" if i % 2 else "LAL vs. BOS"}
        for i in range(20)
    ]

def upward_trend_pts_logs() -> List[Dict[str, Any]]:
    """20 games where last 5 average 30, prior 15 average 22."""
    logs = []
    for i in range(20):
        pts = 30 if i < 5 else 22
        logs.append({
            "game_date": f"2026-05-{20-i:02d}", "minutes": 32, "points": pts,
            "rebounds": 8, "assists": 6, "fg3m": 2, "blocks": 1, "steals": 1,
            "pra": pts + 14, "is_home": i % 2 == 0,
            "matchup": "LAL @ BOS" if i % 2 else "LAL vs. BOS"
        })
    return logs

def sparse_logs() -> List[Dict[str, Any]]:
    """Only 3 games — below most factor minimums."""
    return [
        {"game_date": "2026-05-20", "minutes": 30, "points": 20,
         "rebounds": 5, "assists": 4, "fg3m": 1, "blocks": 0, "steals": 1,
         "pra": 29, "is_home": True, "matchup": "LAL vs. BOS"}
        for _ in range(3)
    ]
