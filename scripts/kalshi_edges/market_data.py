"""Kalshi public market-data reader + prop-title parser. No auth required for reads.

Schema reconciliation (Task 7, verified against live api.elections.kalshi.com on
2026-06-08): Kalshi market dicts expose prices as decimal STRINGS in
`yes_ask_dollars` / `yes_bid_dollars` (e.g. "0.6500"), volume in `volume_fp`, and
the milestone strike as a STRUCTURED field (`strike_type` + `floor_strike` /
`cap_strike`) rather than only in the title. We use those structured fields.

Live format confirmed 2026-10-21: one series per stat (SERIES_STAT), titles
"Player: N+ stat", strike_type "greater" with floor_strike N-0.5.
"""
import math
import re
from dataclasses import dataclass, field
from datetime import date
import requests

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

# One series per stat (live-verified 2026-10-21); each holds every player's
# "N+" rungs for every game. The stat comes from the series, not the title:
# PRA titles ("points, rebounds, and assists") would otherwise match "rebound".
SERIES_STAT = {
    "KXNBAPTS": "points", "KXNBAREB": "rebounds", "KXNBAAST": "assists",
    "KXNBA3PT": "three_pointers", "KXNBABLK": "blocks", "KXNBASTL": "steals",
    "KXNBAPRA": "pra",
}
PROP_SERIES: list[str] = list(SERIES_STAT)
_MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}

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
    series: str = field(default="", compare=False)
    game_date: date | None = field(default=None, compare=False)
    away: str | None = field(default=None, compare=False)
    home: str | None = field(default=None, compare=False)

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

def _series_of(ticker):
    return (ticker or "").split("-")[0]

def _game_of(ticker):
    """'KXNBAPTS-26OCT21PHXPOR-...' -> (date(2026,10,21), 'PHX', 'POR'), else (None, None, None).
    Team codes are 2-3 letters; ambiguous splits (e.g. 5 letters) try 3+2 then 2+3."""
    parts = (ticker or "").split("-")
    if len(parts) < 2:
        return None, None, None
    m = re.match(r"^(\d{2})([A-Z]{3})(\d{2})([A-Z]+)$", parts[1])
    if not m or m.group(2) not in _MONTHS:
        return None, None, None
    yy, mon, dd, teams = m.groups()
    d = date(2000 + int(yy), _MONTHS[mon], int(dd))
    if len(teams) in (5, 6):
        return d, teams[:3], teams[3:]
    if len(teams) == 4:
        return d, teams[:2], teams[2:]
    return d, None, None

def _strike_from(raw):
    """Milestone N for an "N+" market. Kalshi's live props use strike_type='greater'
    with floor_strike = N - 0.5 (24.5 for "25+"), so N = floor(floor_strike) + 1.
    Other strike types keep the structured value as N."""
    if raw.get("floor_strike") is not None:
        fs = float(raw["floor_strike"])
        return math.floor(fs) + 1 if raw.get("strike_type") == "greater" else int(fs)
    if raw.get("cap_strike") is not None:
        return int(float(raw["cap_strike"]))
    text = f"{raw.get('yes_sub_title') or ''} {raw.get('title') or ''}"
    m = STRIKE_RE.search(text)
    return int(m.group(1)) if m else None

def parse_market(raw):
    """Parse one Kalshi market dict into a KalshiProp, or None if not an NBA prop."""
    ticker = raw.get("ticker", "")
    series = _series_of(ticker)
    text = f"{raw.get('title') or ''} {raw.get('yes_sub_title') or ''}"
    stat = SERIES_STAT.get(series) or _classify_stat(text)
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
    gd, away, home = _game_of(ticker)
    return KalshiProp(ticker, player, stat, strike, bid, ask, volume,
                      series=series, game_date=gd, away=away, home=home)

def fetch_market(ticker, session=None):
    """One market by ticker (any status). Returns the raw market dict."""
    sess = session or requests.Session()
    r = sess.get(f"{KALSHI_BASE}/markets/{ticker}", timeout=30)
    r.raise_for_status()
    return r.json()["market"]

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
