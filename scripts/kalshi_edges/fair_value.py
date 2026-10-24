"""Fair P(over book line) per (player, stat) from sportsbook odds.

Two-sided: both directions quoted at the same line by the same book -> normalize
the two implied probabilities to sum to 1 (removes the vig); average across books.
One-sided fallback: implied probability minus half a typical vig (ONE_SIDED_VIG),
flagged 'one_sided'. Odds outside -500..+500 (or |odds| < 100) are ignored, matching
isSaneOdds in lib/ev.ts.
"""
from collections import defaultdict
from dataclasses import dataclass
from kalshi_edges.find_edges import normalize_name

ONE_SIDED_VIG = 0.024
# Books load more of their margin onto the over, so a proportional de-vig overstates
# P(over). Measured on 66.6k paired lines with outcomes: +1.93 pts (Dec 2025-Feb 2026),
# +1.59 pts (Mar 2026), steady across probability buckets. Subtracted from every fair
# P(over); see docs/superpowers/specs/2026-10-21-kalshi-book-price-scanner-design.md.
OVER_BIAS = 0.018

@dataclass
class FairLine:
    player_name: str
    stat: str
    line: float
    p_over: float
    devig: str          # 'two_sided' | 'one_sided'
    books: str
    commence_time: str | None

def american_to_prob(odds):
    if odds is None:
        return None
    o = float(odds)
    if abs(o) < 100 or o < -500 or o > 500:
        return None
    return -o / (-o + 100) if o < 0 else 100 / (o + 100)

def fair_lines(props):
    """Return ({(norm_name, stat): FairLine}, ambiguous_keys).

    Spelling variants of one player (Jokic / Jokić) normalize to the same key and
    are merged. ambiguous_keys is kept for interface stability and is empty today."""
    by_key = defaultdict(list)
    for p in props:
        if american_to_prob(p.get("odds")) is None or p.get("line") is None:
            continue
        by_key[(normalize_name(p["player_name"]), p["stat_type"])].append(p)
    out = {}
    for key, rows in by_key.items():
        pairs = defaultdict(dict)
        for r in rows:
            pairs[(r.get("sportsbook"), float(r["line"]))][r["direction"]] = r
        two = []
        for (book, line), sides in pairs.items():
            if "over" in sides and "under" in sides:
                po = american_to_prob(sides["over"]["odds"])
                pu = american_to_prob(sides["under"]["odds"])
                two.append((line, book, po / (po + pu), sides["over"]))
        if two:
            # Use the line quoted two-sided by the most books; average their fair p.
            counts = defaultdict(list)
            for line, book, p, r in two:
                counts[line].append((book, p, r))
            line = max(counts, key=lambda ln: len(counts[ln]))
            entries = counts[line]
            p_over = sum(p for _, p, _ in entries) / len(entries) - OVER_BIAS
            r0 = entries[0][2]
            out[key] = FairLine(r0["player_name"], key[1], line, p_over, "two_sided",
                                ",".join(sorted(b for b, _, _ in entries if b)), r0.get("commence_time"))
            continue
        over = next((r for r in rows if r["direction"] == "over"), None)
        r = over or rows[0]
        p_side = american_to_prob(r["odds"]) - ONE_SIDED_VIG
        p_over = (p_side if r["direction"] == "over" else 1.0 - p_side) - OVER_BIAS
        out[key] = FairLine(r["player_name"], key[1], float(r["line"]), p_over, "one_sided",
                            r.get("sportsbook") or "", r.get("commence_time"))
    return out, set()
