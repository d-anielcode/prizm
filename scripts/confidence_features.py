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
    season_rank: Optional[int],    # 1-30, lower = stronger defense
    l15_rank: Optional[int],       # 1-30 or None
    dvp_rank: Optional[int],       # 1-30 or None, for player's position
    direction: str,
) -> Optional[float]:
    """Matchup quality vs opponent defense, encoded as deviation from 0.

    Mirrors matchupScore() in lib/confidence.ts:642. Blends season rank with
    L15 rank (60/40 weighted to L15), then 50/50 with positional DVP rank.
    Returns a centered value in [-0.5, 0.5] (positive = favorable for direction).

    A rank of 15.5 = average → returns 0. Rank 1 (best defense) → -0.5 for over,
    +0.5 for under. Rank 30 (worst defense) → +0.5 for over, -0.5 for under.
    """
    if season_rank is None or season_rank < 1 or season_rank > 30:
        return None
    # 60/40 blend with L15 if available
    if l15_rank is not None and 1 <= l15_rank <= 30:
        blended = season_rank * 0.40 + l15_rank * 0.60
    else:
        blended = float(season_rank)
    # 50/50 blend with DVP if available
    if dvp_rank is not None and 1 <= dvp_rank <= 30:
        final = blended * 0.50 + dvp_rank * 0.50
    else:
        final = blended
    # Center around 15.5, scale to [-0.5, 0.5]
    raw = (final - 15.5) / 14.5 * 0.5
    if direction == "under":
        raw = -raw
    return max(-0.5, min(0.5, raw))

def opponent_leak(
    over_hit_rate: Optional[float],
    sample_count: Optional[int],
    direction: str,
) -> Optional[float]:
    """Opponent-vs-position leak adjustment.

    Mirrors leakAdj in lib/confidence.ts:993. Requires sample_count >= 10.
    Confidence-shrinkage: cs = min(sample_count / 40, 1.0).
    raw = (over_hit_rate - 0.50) * cs * 8. Cap ±4. Under flips sign.
    """
    if over_hit_rate is None or sample_count is None or sample_count < 10:
        return None
    cs = min(sample_count / 40.0, 1.0)
    raw = (over_hit_rate - 0.50) * cs * 8
    if direction == "under":
        raw = -raw
    return max(-4.0, min(4.0, raw))

def player_bias(
    hit_rate: Optional[float],
    sample_count: Optional[int],
    direction: str,
) -> Optional[float]:
    """Player-specific historical line-bias adjustment.

    Mirrors biasAdj in lib/confidence.ts:966. Requires sample_count >= 6.
    cs = min(sample_count / 20, 1.0). raw = (hit_rate - 0.50) * cs * 10.
    Cap ±5. Under flips sign.
    """
    if hit_rate is None or sample_count is None or sample_count < 6:
        return None
    cs = min(sample_count / 20.0, 1.0)
    raw = (hit_rate - 0.50) * cs * 10
    if direction == "under":
        raw = -raw
    return max(-5.0, min(5.0, raw))

def compute_all_features(
    prop: Dict[str, Any],
    logs: List[Dict[str, Any]],
    ctx: Dict[str, Any],
) -> Dict[str, Optional[float]]:
    """Orchestrator. Returns dict with all 12 reconstructable factors.

    Required prop fields: stat_type, line, direction, game_date
    Required ctx fields: prop_is_home, opponent, opponent_pace, season_rank,
                          l15_rank, dvp_rank, spread, leak_over_hit_rate,
                          leak_sample_count, bias_hit_rate, bias_sample_count
    Missing ctx fields → that factor returns None.
    """
    s, l, d = prop["stat_type"], float(prop["line"]), prop["direction"]
    return {
        "line_value":       line_value(logs, s, l, d),
        "matchup_edge":     matchup_edge(ctx.get("season_rank"), ctx.get("l15_rank"),
                                          ctx.get("dvp_rank"), d),
        "last20_hit_rate":  last20_hit_rate(logs, s, l, d),
        "trend":            trend(logs, s),
        "season_cushion":   season_cushion(logs, s, l, d),
        "pace":             pace(ctx.get("opponent_pace")),
        "rest_days":        rest_days(logs, prop.get("game_date")),
        "blowout":          blowout(ctx.get("spread")),
        "home_away":        home_away(logs, s, l, d, ctx.get("prop_is_home", False)),
        "vs_opponent":      vs_opponent(logs, s, l, d, ctx.get("opponent", "")),
        "opponent_leak":    opponent_leak(ctx.get("leak_over_hit_rate"),
                                           ctx.get("leak_sample_count"), d),
        "player_bias":      player_bias(ctx.get("bias_hit_rate"),
                                         ctx.get("bias_sample_count"), d),
    }
