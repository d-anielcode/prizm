"""ESPN scoreboard tip times, indexed by every 'AWAYHOME' spelling a Kalshi ticker may use."""
from datetime import datetime
import requests

from kalshi_edges.teams import spellings

SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"


def _parse_dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def tip_index(scoreboard):
    """{away_spelling + home_spelling: tip datetime (UTC)} for every spelling pair."""
    out = {}
    for ev in scoreboard.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        side = {c.get("homeAway"): c.get("team", {}).get("abbreviation") for c in comp.get("competitors", [])}
        if not side.get("away") or not side.get("home") or not ev.get("date"):
            continue
        tip = _parse_dt(ev["date"])
        for a in spellings(side["away"]):
            for h in spellings(side["home"]):
                out[a + h] = tip
    return out


def fetch_tip_index(game_date, session=None):
    """game_date: datetime.date (ET game date). Returns tip_index for that date."""
    sess = session or requests.Session()
    r = sess.get(SCOREBOARD, params={"dates": game_date.strftime("%Y%m%d")}, timeout=30)
    r.raise_for_status()
    return tip_index(r.json())
