import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from datetime import date, datetime, timedelta, timezone
from kalshi_edges.maker_quotes import eligible_sides, best_bid, make_quote, tip_for

TIP = datetime(2026, 11, 20, 0, 30, tzinfo=timezone.utc)


def test_eligible_both_sides_in_band():
    now = TIP - timedelta(hours=1)
    # yes bid 0.70 in band; no bid = 1 - 0.25 = 0.75 in band
    assert eligible_sides(0.70, 0.25, now, TIP) == [("yes", 0.70), ("no", 0.75)]


def test_eligible_band_edges():
    now = TIP - timedelta(hours=1)
    assert eligible_sides(0.60, 0.95, now, TIP) == [("yes", 0.60)]   # 0.60 in; no side 0.05 out
    assert eligible_sides(0.90, 0.95, now, TIP) == []                # 0.90 out (half-open)
    assert eligible_sides(0.05, 0.10, now, TIP) == []                # no side = 0.90, out (half-open)


def test_eligible_window_edges():
    assert eligible_sides(0.70, 0.75, TIP - timedelta(hours=3), TIP) == [("yes", 0.70)]
    assert eligible_sides(0.70, 0.75, TIP - timedelta(hours=3, seconds=1), TIP) == []
    assert eligible_sides(0.70, 0.75, TIP, TIP) == []
    assert eligible_sides(0.70, 0.75, TIP + timedelta(minutes=5), TIP) == []
    assert eligible_sides(0.70, 0.75, TIP - timedelta(hours=1), None) == []


def test_eligible_missing_prices():
    now = TIP - timedelta(hours=1)
    assert eligible_sides(None, None, now, TIP) == []
    assert eligible_sides(0.0, 1.0, now, TIP) == []


BOOK = {"orderbook_fp": {"yes_dollars": [["0.6000", "10.00"], ["0.6800", "250.00"], ["0.7000", "0.00"]],
                         "no_dollars": [["0.2500", "40.00"], ["0.3000", "12.50"]]}}


def test_best_bid_skips_empty_levels():
    assert best_bid(BOOK, "yes") == (0.68, 250.0)
    assert best_bid(BOOK, "no") == (0.30, 12.5)
    assert best_bid({"orderbook_fp": {"yes_dollars": None}}, "yes") is None
    assert best_bid({}, "no") is None


def test_make_quote_uses_book_price_and_depth():
    now = TIP - timedelta(hours=2)
    q = make_quote("KXNBATOTAL-26NOV19GSWMEM-230", "totals", "yes", BOOK, now, TIP, "2026-11-19")
    assert q == {"ticker": "KXNBATOTAL-26NOV19GSWMEM-230", "market": "totals", "side": "yes",
                 "price": 0.68, "queue_ahead": 250.0, "posted_at": now.isoformat(),
                 "tip_time": TIP.isoformat(), "game_date": "2026-11-19"}


def test_make_quote_none_when_book_out_of_band():
    now = TIP - timedelta(hours=2)
    assert make_quote("T", "totals", "no", BOOK, now, TIP, "2026-11-19") is None   # 0.30 out of band


def test_tip_for_tries_spellings():
    tips = {"GSWMEM": TIP}
    assert tip_for(tips, "GSW", "MEM") == TIP
    assert tip_for(tips, "GS", "MEM") == TIP      # alias spelling resolves via teams.spellings
    assert tip_for(tips, "LAL", "BOS") is None
    assert tip_for(tips, None, "MEM") is None
