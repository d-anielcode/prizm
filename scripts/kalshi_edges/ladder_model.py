"""Full-ladder bridge (spec 2026-11-11). Pure functions, no I/O.

Stretch the sportsbook model's calibrated P(over book line) across every Kalshi rung:
fit the player's stat distribution from prior game logs, solve one mean shift so
P(over anchor line) matches the model, then read P(X >= N) at each Kalshi strike.
"""
from collections import Counter, defaultdict
from datetime import datetime, time as dtime, timedelta, timezone
from statistics import mean
from zoneinfo import ZoneInfo

from kalshi_edges.find_edges import normalize_name
from kalshi_edges.prizm_data import apply_calibration
from kalshi_edges.prob_model import fit_distribution, prob_at_strike, solve_shift

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


def exact_strikes(scored):
    """Strikes N where some scored .5 line sits at N - 0.5 (either direction)."""
    out = set()
    for r in scored:
        x = float(r["line"]) + 0.5
        if x.is_integer():
            out.add(int(x))
    return out


def ladder_probs(scored, logs, stat, strikes, game_date, calib):
    """({anchor_line, anchor_p, delta, probs{strike: p}, exact{strike: bool}}, None)
    or (None, reason) with reason in no_anchor | few_games | clamped."""
    a = anchor(scored, stat, calib)
    if a is None:
        return None, "no_anchor"
    line, p = a
    try:
        dist = fit_distribution(prior_logs(logs, game_date), stat)
    except ValueError:
        return None, "few_games"
    delta, clamped = solve_shift(dist, line, p)
    if clamped:
        return None, "clamped"
    ex = exact_strikes(scored)
    return {"anchor_line": line, "anchor_p": p, "delta": delta,
            "probs": {s: prob_at_strike(dist, delta, s) for s in strikes},
            "exact": {s: s in ex for s in strikes}}, None


def build_rungs(markets, scored, logs, calib, game_date, computed_at):
    """kalshi_model_rungs rows for one ET game date, plus Counter of skip reasons
    (one count per player/stat ladder). Markets outside LADDER_STATS are ignored.
    Names join on find_edges.normalize_name."""
    sc_idx = defaultdict(list)
    for r in scored:
        if r.get("stat_type") in LADDER_STATS:
            sc_idx[(normalize_name(r["player_name"]), r["stat_type"])].append(r)
    log_idx = defaultdict(list)
    for g in logs:
        log_idx[normalize_name(g["player_name"])].append(g)
    ladders = defaultdict(list)
    for m in markets:
        if m["stat"] in LADDER_STATS:
            ladders[(normalize_name(m["player"]), m["stat"])].append(m)

    rows, skips = [], Counter()
    for (name, stat), ms in ladders.items():
        rows_sc = sc_idx.get((name, stat), [])
        res, why = ladder_probs(rows_sc, log_idx.get(name, []), stat,
                                sorted({int(m["strike"]) for m in ms}), game_date, calib)
        if res is None:
            skips[why] += 1
            continue
        tips = sorted(r["commence_time"] for r in rows_sc if r.get("commence_time"))
        for m in ms:
            s = int(m["strike"])
            rows.append({"ticker": m["ticker"], "player": m["player"], "stat": stat, "strike": s,
                         "game_date": game_date, "model_p": round(res["probs"][s], 4),
                         "anchor_line": res["anchor_line"], "anchor_p": round(res["anchor_p"], 4),
                         "delta": round(res["delta"], 4), "exact": res["exact"][s],
                         "commence_time": tips[0] if tips else None, "computed_at": computed_at})
    return rows, dict(skips)


ET = ZoneInfo("America/New_York")


def et_day_window(d):
    """[start, end) of ET calendar date d as UTC ISO strings."""
    start = datetime.combine(d, dtime(0), tzinfo=ET).astimezone(timezone.utc)
    end = datetime.combine(d + timedelta(days=1), dtime(0), tzinfo=ET).astimezone(timezone.utc)
    return start.isoformat(), end.isoformat()
