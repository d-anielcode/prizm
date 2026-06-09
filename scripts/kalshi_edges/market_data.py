"""Kalshi public market-data reader + prop-title parser. No auth required for reads."""
import re
import requests
from dataclasses import dataclass

KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2"

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
    name = (t[:m.start()] if m else t).strip(" ?:-")
    return name if len(name.split()) >= 2 else None

def _cents(v):
    return None if v is None else float(v) / 100.0

def parse_market(raw):
    """Parse one Kalshi market dict into a KalshiProp, or None if not an NBA prop."""
    text = f"{raw.get('title') or ''} {raw.get('subtitle') or ''}"
    stat = _classify_stat(text)
    if stat is None:
        return None
    m = STRIKE_RE.search(text)
    if not m:
        return None
    player = _extract_player(raw.get("title") or "")
    if not player:
        return None
    ask = _cents(raw.get("yes_ask"))
    if ask is None:
        return None
    return KalshiProp(raw.get("ticker", ""), player, stat, int(m.group(1)),
                      _cents(raw.get("yes_bid")) or 0.0, ask, int(raw.get("volume") or 0))

def fetch_markets(limit_pages=10, session=None):
    """Page through open Kalshi markets. Returns raw market dicts."""
    sess = session or requests.Session()
    out, cursor = [], None
    for _ in range(limit_pages):
        params = {"limit": 1000, "status": "open"}
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

def fetch_props(session=None):
    """Convenience: fetch + parse, dropping non-props."""
    return [kp for raw in fetch_markets(session=session) if (kp := parse_market(raw))]
