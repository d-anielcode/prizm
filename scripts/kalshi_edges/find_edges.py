"""Join Kalshi prop markets to Prizm props, compute edges, print + dump a report."""
import argparse
import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, asdict
from datetime import date

from kalshi_edges import market_data, prizm_data, prob_model

def normalize_name(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv)\b", "", s)
    s = re.sub(r"[^a-z ]", "", s)
    return re.sub(r"\s+", " ", s).strip()

def build_prop_index(props):
    """Return (index, ambiguous_keys). A key is ambiguous if two different raw
    player names normalize to the same (name, stat) pair."""
    index, raw_seen, ambiguous = {}, defaultdict(set), set()
    for p in props:
        key = (normalize_name(p["player_name"]), p["stat_type"])
        raw_seen[key].add(p["player_name"].strip())
        index[key] = p
    for key, names in raw_seen.items():
        if len(names) > 1:
            ambiguous.add(key)
    return index, ambiguous

@dataclass
class Edge:
    player: str
    stat: str
    strike: int
    model_p: float
    yes_ask: float
    edge: float
    volume: int
    flag: str

def compute_edge(kp, prop, logs, calib, ambiguous=False):
    try:
        dist = prob_model.fit_distribution(logs, kp.stat)
    except ValueError:
        return None
    flags = []
    delta = 0.0
    if prop is not None and not ambiguous:
        p_hit = prizm_data.apply_calibration(calib, kp.stat, prop["confidence_score"])
        p_over = p_hit if prop["direction"] == "over" else 1.0 - p_hit
        delta, clamped = prob_model.solve_shift(dist, float(prop["line"]), p_over)
        flags.append("clamped" if clamped else "factored")
    else:
        flags.append("ambiguous" if ambiguous else "unfactored")
    model_p = prob_model.prob_at_strike(dist, delta, kp.strike)
    return Edge(kp.player, kp.stat, kp.strike, round(model_p, 4),
                kp.yes_ask, round(model_p - kp.yes_ask, 4), kp.volume, "+".join(flags))

def find_edges(kalshi_props, prop_index, ambiguous_keys, logs_by_player, calib,
               min_edge=0.0, min_volume=0):
    edges = []
    for kp in kalshi_props:
        nname = normalize_name(kp.player)
        key = (nname, kp.stat)
        e = compute_edge(kp, prop_index.get(key), logs_by_player.get(nname, []),
                         calib, ambiguous=(key in ambiguous_keys))
        if e is None or e.volume < min_volume or abs(e.edge) < min_edge:
            continue
        edges.append(e)
    edges.sort(key=lambda e: e.edge, reverse=True)
    return edges

def _group_logs(logs):
    by_player = defaultdict(list)
    for g in logs:
        by_player[normalize_name(g["player_name"])].append(g)
    return by_player

def main():
    ap = argparse.ArgumentParser(description="Kalshi NBA prop edge finder (read-only)")
    ap.add_argument("--game-date", default=date.today().isoformat())
    ap.add_argument("--min-edge", type=float, default=0.03)
    ap.add_argument("--min-volume", type=int, default=0)
    ap.add_argument("--stat", default=None, help="filter to one stat_type")
    ap.add_argument("--calibration", default="lib/calibration-table.json")
    args = ap.parse_args()

    kalshi = market_data.fetch_props()
    if args.stat:
        kalshi = [k for k in kalshi if k.stat == args.stat]
    props = prizm_data.todays_props(args.game_date)
    if not props:
        print(f"WARNING: no scored props for {args.game_date}; all edges will be unfactored.")
    index, ambiguous = build_prop_index(props)
    logs_by_player = _group_logs(prizm_data.all_logs())
    calib = prizm_data.load_calibration(args.calibration)

    edges = find_edges(kalshi, index, ambiguous, logs_by_player, calib,
                       args.min_edge, args.min_volume)

    print(f"\n{'PLAYER':<22} {'STAT':<14} {'K':>3} {'MODEL':>6} {'ASK':>6} {'EDGE':>7} {'VOL':>6}  FLAG")
    print("-" * 80)
    for e in edges:
        print(f"{e.player:<22} {e.stat:<14} {e.strike:>3} {e.model_p:>6.2f} "
              f"{e.yes_ask:>6.2f} {e.edge:>+7.2f} {e.volume:>6}  {e.flag}")
    print(f"\n{len(edges)} edges (min_edge={args.min_edge}, min_volume={args.min_volume})")

    out = f"kalshi_edges_{args.game_date}.json"
    with open(out, "w") as f:
        json.dump([asdict(e) for e in edges], f, indent=2)
    print(f"Written to {out}")

if __name__ == "__main__":
    main()
