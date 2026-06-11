"""Kalshi public market-data reader + prop-title parser. No auth required for reads.

Schema reconciliation (Task 7, verified against live api.elections.kalshi.com on
2026-06-08): Kalshi market dicts expose prices as decimal STRINGS in
`yes_ask_dollars` / `yes_bid_dollars` (e.g. "0.6500"), volume in `volume_fp`, and
the milestone strike as a STRUCTURED field (`strike_type` + `floor_strike` /
`cap_strike`) rather than only in the title. We use those structured fields.

STILL PENDING (could not finalize on 2026-06-08 — no single-game NBA player-prop
markets were open during the Finals off-day): the exact single-game prop title
format and the per-game series tickers. Kalshi has no single umbrella "NBA props"
series; props are listed per game-day under per-player/per-stat series tickers,
typically only a few hours before tip. `fetch_props` therefore scans an explicit
list of series tickers (`PROP_SERIES`), to be populated on an NBA game day. The
player/stat title heuristic below is the one piece awaiting live confirmation.
"""
import re
import requests
from dataclasses import dataclass

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

# Per-game-day NBA player-prop series tickers to scan. Empty until reconciled on a
# game day (see module docstring). Populate, e.g., ["KXNBAPTSLEBRON", ...].
PROP_SERIES: list[str] = []

# Order matters: 'point' is generic, so it is checked last. PRA before points.
STAT_KEYWORDS = [
    ("three_pointers", ("three-pointer", "three pointer", "3-pointer", "threes", "3pm")),
    ("rebounds", ("rebound",)),
    ("assists", ("assist",)),
    ("steals", ("steal",)),
    ("blocks", ("block",)),
    ("pra", ("points + rebounds + assists", "pts+reb+ast", "pra")),
    ("points", ("point",)),
]
STRIKE_RE = re.compile(r"(\d+)\s*\+")
_CUE_RE = re.compile(r"\b(to record|to score|to make|to grab|record|score|make|grab|dish|with)\b", re.I)

@dataclass
class KalshiProp:
    ticker: str
    player: str
    stat: str
    strike: int
    yes_bid: float   # 0..1
    yes_ask: float   # 0..1
    volume: int

def _classify_stat(text):
    t = text.lower()
    for stat, kws in STAT_KEYWORDS:
        if any(k in t for k in kws):
            return stat
    return None

def _extract_player(title):
    t = re.sub(r"^\s*will\s+", "", title, flags=re.I).strip()
    m = _CUE_RE.search(t)
    if m:
        name = t[:m.start()]
    else:
        # No verb cue: cut at the "<n>+" milestone so we don't return the whole
        # "<name> 30+ points" tail as the player. If there's no milestone either,
        # we have nothing reliable to cut on.
        sm = STRIKE_RE.search(t)
        name = t[:sm.start()] if sm else t
    name = name.strip(" ?:-")
    # A real player name is 2-4 tokens (incl. Jr./III). More than that means the
    # cut failed and we'd return a polluted string that matches no Prizm prop.
    return name if 2 <= len(name.split()) <= 4 else None

def _dollars(v):
    """Parse a Kalshi '_dollars' price string ('0.6500') to float in [0,1], or None."""
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def _strike_from(raw):
    """Milestone strike: prefer the structured floor/cap strike, fall back to '<n>+'."""
    if raw.get("floor_strike") is not None:
        return int(float(raw["floor_strike"]))
    if raw.get("cap_strike") is not None:
        return int(float(raw["cap_strike"]))
    text = f"{raw.get('yes_sub_title') or ''} {raw.get('title') or ''}"
    m = STRIKE_RE.search(text)
    return int(m.group(1)) if m else None

def parse_market(raw):
    """Parse one Kalshi market dict into a KalshiProp, or None if not an NBA prop."""
    text = f"{raw.get('title') or ''} {raw.get('yes_sub_title') or ''}"
    stat = _classify_stat(text)
    if stat is None:
        return None
    strike = _strike_from(raw)
    if strike is None:
        return None
    player = _extract_player(raw.get("title") or "")
    if not player:
        return None
    ask = _dollars(raw.get("yes_ask_dollars"))
    if ask is None:
        return None
    bid = _dollars(raw.get("yes_bid_dollars")) or 0.0
    volume = int(float(raw.get("volume_fp") or 0))
    return KalshiProp(raw.get("ticker", ""), player, stat, strike, bid, ask, volume)

def fetch_markets(series_ticker, session=None):
    """Page through open markets for one series ticker. Returns raw market dicts."""
    sess = session or requests.Session()
    out, cursor = [], None
    while True:
        params = {"limit": 1000, "status": "open", "series_ticker": series_ticker}
        if cursor:
            params["cursor"] = cursor
        r = sess.get(f"{KALSHI_BASE}/markets", params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        out.extend(data.get("markets", []))
        cursor = data.get("cursor")
        if not cursor:
            break
    return out

def fetch_props(series_tickers=None, session=None):
    """Fetch + parse props across the given series tickers (default: PROP_SERIES)."""
    sess = session or requests.Session()
    series = PROP_SERIES if series_tickers is None else series_tickers
    out = []
    for st in series:
        for raw in fetch_markets(st, session=sess):
            kp = parse_market(raw)
            if kp:
                out.append(kp)
    return out
