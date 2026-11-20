from datetime import datetime, timezone
from kalshi_edges.espn import tip_index

SCOREBOARD = {"events": [
    {"date": "2026-06-14T00:30Z", "competitions": [{"competitors": [
        {"homeAway": "home", "team": {"abbreviation": "SA"}},
        {"homeAway": "away", "team": {"abbreviation": "NY"}}]}]},
]}

def test_tip_index_matches_kalshi_spelling():
    idx = tip_index(SCOREBOARD)
    tip = datetime(2026, 6, 14, 0, 30, tzinfo=timezone.utc)
    assert idx["NYKSAS"] == tip
    assert idx["NYSA"] == tip
    assert "SASNYK" not in idx          # order is away+home
