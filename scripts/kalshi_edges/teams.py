"""NBA team-code canonicalization across ESPN, odds feeds and Kalshi tickers."""
import re

_ALIASES = {
    "GS": "GSW", "NO": "NOP", "NY": "NYK", "SA": "SAS", "UTAH": "UTA", "UTH": "UTA",
    "WSH": "WAS", "NJ": "BKN", "BRK": "BKN", "PHO": "PHX", "CHO": "CHA",
}
_REVERSE = {}
for a, c in _ALIASES.items():
    _REVERSE.setdefault(c, set()).add(a)


def canon(code):
    c = (code or "").upper()
    return _ALIASES.get(c, c)


def spellings(code):
    """Every spelling a team may appear under (canonical + known aliases)."""
    c = canon(code)
    return {c, (code or "").upper()} | _REVERSE.get(c, set())


_GAME_RE = re.compile(r"^\d{2}[A-Z]{3}\d{2}([A-Z]+)$")


def ticker_teams(ticker):
    """'KXNBAPTS-26JUN13NYKSAS-...' -> 'NYKSAS' (away+home as Kalshi spells them)."""
    parts = (ticker or "").split("-")
    if len(parts) < 2:
        return None
    m = _GAME_RE.match(parts[1])
    return m.group(1) if m else None
