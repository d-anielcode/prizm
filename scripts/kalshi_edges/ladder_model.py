"""Full-ladder bridge (spec 2026-11-11). Pure functions, no I/O.

Stretch the sportsbook model's calibrated P(over book line) across every Kalshi rung:
fit the player's stat distribution from prior game logs, solve one mean shift so
P(over anchor line) matches the model, then read P(X >= N) at each Kalshi strike.
"""
from collections import defaultdict
from statistics import mean

from kalshi_edges.prizm_data import apply_calibration

LADDER_STATS = ("points", "rebounds", "assists", "three_pointers", "pra")
LOG_WINDOW = 40


def anchor(scored, stat, calib):
    """(anchor_line, p_over) for one player/stat/game, or None.

    scored: dicts with line, direction ('over'|'under'), confidence_score.
    Each row's score is calibrated to P(that side hits); duplicate books are averaged.
    Lines with both sides scored win; among them (or among one-sided lines when none
    has both) the line whose P(over) is closest to 0.5 is the anchor."""
    by_line = defaultdict(lambda: {"over": [], "under": []})
    for r in scored:
        d, s = r.get("direction"), r.get("confidence_score")
        if d not in ("over", "under") or s is None:
            continue
        by_line[float(r["line"])][d].append(apply_calibration(calib, stat, float(s)))
    cands = []
    for line, d in by_line.items():
        if d["over"] and d["under"]:
            p, both = (mean(d["over"]) + 1 - mean(d["under"])) / 2, True
        elif d["over"]:
            p, both = mean(d["over"]), False
        else:
            p, both = 1 - mean(d["under"]), False
        cands.append((not both, abs(p - 0.5), line, p))
    if not cands:
        return None
    _, _, line, p = min(cands)
    return line, p


def prior_logs(logs, before_date, n=LOG_WINDOW):
    """Up to n games strictly before before_date (YYYY-MM-DD), newest first."""
    prior = [g for g in logs if str(g["game_date"])[:10] < before_date]
    prior.sort(key=lambda g: str(g["game_date"])[:10], reverse=True)
    return prior[:n]
