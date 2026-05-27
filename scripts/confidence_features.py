# scripts/confidence_features.py
"""Python port of reconstructable factors from lib/confidence.ts.

Each function MUST be bit-identical (within float epsilon) to its TS
counterpart. Verified by scripts/tests/test_ts_parity.py.

Stat keys used in logs: points, rebounds, assists, pra, fg3m, blocks, steals.
Stat keys used in props (stat_type): points, rebounds, assists, pra,
three_pointers, blocks, steals.
"""
from typing import List, Dict, Optional, Any

STAT_TO_LOG_KEY = {
    "points": "points", "rebounds": "rebounds", "assists": "assists",
    "pra": "pra", "blocks": "blocks", "steals": "steals",
    "three_pointers": "fg3m",
}

MIN_MINUTES = 5  # mirrors lib/confidence.ts:hitRate filter

def _qualifying_logs(logs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filter to logs with minutes >= MIN_MINUTES (matches TS scorer behavior)."""
    return [g for g in logs if float(g.get("minutes") or 0) >= MIN_MINUTES]

def last20_hit_rate(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
) -> Optional[float]:
    """Fraction of last 20 qualifying games where actual hits the line.

    Mirrors hitRate() in lib/confidence.ts:483. Direction-aware:
      over  → actual > line
      under → actual < line
    Returns None if no qualifying games.
    """
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)[:20]
    if not qualifying:
        return None
    hits = 0
    for g in qualifying:
        actual = float(g.get(field) or 0)
        if direction == "under":
            if actual < line:
                hits += 1
        else:
            if actual > line:
                hits += 1
    return hits / len(qualifying)

def trend(logs: List[Dict[str, Any]], stat_type: str) -> Optional[float]:
    """Relative trend = (last5_avg - prior15_avg) / prior15_avg.

    Mirrors trendScore() in lib/confidence.ts:747. Returns None if fewer
    than 5 recent OR 5 prior qualifying games available. Caps at +/- 0.5.
    """
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)
    if len(qualifying) < 10:
        return None
    recent = qualifying[:5]
    prior  = qualifying[5:20]
    if len(prior) < 5:
        return None
    r_avg = sum(float(g.get(field) or 0) for g in recent) / len(recent)
    p_avg = sum(float(g.get(field) or 0) for g in prior) / len(prior)
    if p_avg <= 0:
        return None
    raw = (r_avg - p_avg) / p_avg
    return max(-0.5, min(0.5, raw))

def season_cushion(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
) -> Optional[float]:
    """Relative gap between season average and the line.

    Mirrors cushionScore() in lib/confidence.ts. Direction-aware:
      over  → (avg - line) / line
      under → (line - avg) / line
    Clamped to [-0.5, 0.5]. Returns None if no qualifying logs or line <= 0.
    """
    if line <= 0:
        return None
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)
    if not qualifying:
        return None
    avg = sum(float(g.get(field) or 0) for g in qualifying) / len(qualifying)
    raw = (avg - line) / line if direction == "over" else (line - avg) / line
    return max(-0.5, min(0.5, raw))

def line_value(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
) -> Optional[float]:
    """How favorable the line is vs the player's median.

    Mirrors lineValueScore() in lib/confidence.ts. Uses median over last 20
    qualifying games. Direction-aware sign: positive = favorable.
    Clamped to [-0.3, 0.3].
    """
    if line <= 0:
        return None
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)[:20]
    if not qualifying:
        return None
    vals = sorted(float(g.get(field) or 0) for g in qualifying)
    n = len(vals)
    median = vals[n // 2] if n % 2 else (vals[n // 2 - 1] + vals[n // 2]) / 2
    raw = (median - line) / line if direction == "over" else (line - median) / line
    return max(-0.3, min(0.3, raw))

def home_away(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
    prop_is_home: bool,
) -> Optional[float]:
    """Differential between same-venue average and opposite-venue average.

    Mirrors homeAwaySplit() in lib/confidence.ts. Positive when player's
    venue-specific average favors hitting the prop in the requested direction.
    Clamped to [-0.25, 0.25]. Returns None if either bucket is empty.
    """
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    qualifying = _qualifying_logs(logs)
    same_venue = [g for g in qualifying if bool(g.get("is_home")) == prop_is_home]
    if not same_venue:
        return None
    avg = sum(float(g.get(field) or 0) for g in same_venue) / len(same_venue)
    if line <= 0:
        return None
    raw = (avg - line) / line if direction == "over" else (line - avg) / line
    return max(-0.25, min(0.25, raw))

def _extract_opponent(matchup: str) -> Optional[str]:
    """Mirrors extractOpponent() in lib/confidence.ts:474."""
    if not matchup:
        return None
    if " @ " in matchup:
        return matchup.split(" @ ")[1].strip()
    if " vs. " in matchup:
        return matchup.split(" vs. ")[1].strip()
    return None

def vs_opponent(
    logs: List[Dict[str, Any]],
    stat_type: str,
    line: float,
    direction: str,
    opponent: str,
) -> Optional[float]:
    """Performance vs this specific opponent across all available games.

    Mirrors vsOpponentScore() in lib/confidence.ts:700. Requires at least
    one historical game vs opponent. Clamped to [-0.3, 0.3].
    """
    if not opponent or line <= 0:
        return None
    field = STAT_TO_LOG_KEY.get(stat_type, stat_type)
    matching = [g for g in _qualifying_logs(logs)
                if _extract_opponent(g.get("matchup", "")) == opponent]
    if not matching:
        return None
    avg = sum(float(g.get(field) or 0) for g in matching) / len(matching)
    raw = (avg - line) / line if direction == "over" else (line - avg) / line
    return max(-0.3, min(0.3, raw))
