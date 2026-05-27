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

from datetime import date as _date

def rest_days(logs: List[Dict[str, Any]], prop_game_date: str) -> Optional[float]:
    """Score based on days since last qualifying game.

    Mirrors restDaysScore() in lib/confidence.ts:836.
      0 days (b2b): -0.08
      1 day:        -0.03
      2 days:        0.00
      3 days:       +0.04
      4+ days:      +0.06
    """
    if not logs or not prop_game_date:
        return None
    qualifying = _qualifying_logs(logs)
    if not qualifying:
        return None
    last_date_str = qualifying[0].get("game_date")
    if not last_date_str:
        return None
    pgd = _date.fromisoformat(prop_game_date)
    lgd = _date.fromisoformat(str(last_date_str)[:10])
    delta = (pgd - lgd).days
    if delta <= 0:    return -0.08
    if delta == 1:    return -0.03
    if delta == 2:    return 0.00
    if delta == 3:    return 0.04
    return 0.06

def pace(opponent_pace: Optional[float], league_avg_pace: float = 100.0) -> Optional[float]:
    """Pace differential vs league average, normalized.

    Mirrors paceScore() in lib/confidence.ts:585. Clamped to [-0.15, 0.15].
    """
    if opponent_pace is None or league_avg_pace <= 0:
        return None
    raw = (opponent_pace - league_avg_pace) / league_avg_pace
    return max(-0.15, min(0.15, raw))

def blowout(spread: Optional[float]) -> Optional[float]:
    """Adjustment for projected blowout risk.

    Mirrors blowoutScore() in lib/confidence.ts:770. Larger absolute
    spreads pull score down (starter minutes get cut). Capped at -0.12.
    """
    if spread is None:
        return None
    abs_sp = abs(spread)
    if abs_sp < 6:    return 0.0
    if abs_sp < 9:    return -0.04
    if abs_sp < 12:   return -0.08
    return -0.12

def matchup_edge(
    def_rank: Optional[int],
    dvp_value: Optional[float],
    direction: str,
    league_avg: float,
) -> Optional[float]:
    """Matchup quality vs opponent defense.

    Mirrors matchupScore() in lib/confidence.ts:623. Combines def_rank
    (1-30, lower = stronger) with DVP (defense-vs-position) value.
    Returns positive when matchup favors the prop direction.
    """
    if def_rank is None or dvp_value is None or league_avg <= 0:
        return None
    rank_score = ((def_rank - 15.5) / 14.5) * 0.15
    dvp_delta = (dvp_value - league_avg) / league_avg
    dvp_score = max(-0.15, min(0.15, dvp_delta))
    raw = (rank_score + dvp_score) / 2
    if direction == "under":
        raw = -raw
    return max(-0.2, min(0.2, raw))

def opponent_leak(leak_value: Optional[float], direction: str) -> Optional[float]:
    """Opponent-vs-position leak adjustment.

    Mirrors leakAdj in lib/confidence.ts computeAdditives. mult=8, cap=±4
    (matches the 2026-05-23 revert from mult=15/cap=6).
    """
    if leak_value is None:
        return None
    raw = leak_value * 8
    if direction == "under":
        raw = -raw
    return max(-4.0, min(4.0, raw))

def player_bias(
    hit_rate: Optional[float],
    sample_count: Optional[int],
    direction: str,
) -> Optional[float]:
    """Player-specific historical line-bias adjustment.

    hit_rate comes from player_line_bias.hit_rate (now 70/30 recency-blended).
    Confidence-shrinkage by sample size: factor = min(n/30, 1.0).
    Final = (hit_rate - 0.5) * 20 * shrinkage. Clamped to ±5.
    """
    if hit_rate is None or sample_count is None or sample_count <= 0:
        return None
    shrinkage = min(sample_count / 30.0, 1.0)
    raw = (hit_rate - 0.5) * 20 * shrinkage
    if direction == "under":
        raw = -raw
    return max(-5.0, min(5.0, raw))
