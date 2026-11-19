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


from kalshi_edges.maker_quotes import fill_time

POSTED = TIP - timedelta(hours=2)


def quote(side="yes", price=0.70, queue=100.0):
    return {"side": side, "price": price, "queue_ahead": queue,
            "posted_at": POSTED.isoformat(), "tip_time": TIP.isoformat()}


def tr(minutes_after_post, yes_price, count, taker_side, block=False):
    t = POSTED + timedelta(minutes=minutes_after_post)
    return {"created_time": t.isoformat().replace("+00:00", "Z"), "yes_price_dollars": f"{yes_price:.4f}",
            "count_fp": f"{count:.2f}", "taker_side": taker_side, "is_block_trade": block}


def test_through_price_fills_immediately():
    # YES bid at 0.70; a taker sells YES at 0.65 (taker_side 'no') -> went through our level
    trades = [tr(10, 0.65, 1, "no")]
    assert fill_time(quote(), trades) == trades[0]["created_time"]


def test_queue_consumed_then_next_hit_fills():
    trades = [tr(5, 0.70, 60, "no"), tr(6, 0.70, 40, "no"), tr(7, 0.70, 1, "no")]
    # 60 + 40 = 100 exactly consumes the queue; we fill on the third trade
    assert fill_time(quote(queue=100), trades) == trades[2]["created_time"]


def test_queue_overrun_in_one_trade_fills_on_that_trade():
    trades = [tr(5, 0.70, 150, "no")]
    assert fill_time(quote(queue=100), trades) == trades[0]["created_time"]


def test_queue_never_consumed_no_fill():
    assert fill_time(quote(queue=100), [tr(5, 0.70, 99, "no")]) is None


def test_wrong_side_and_better_priced_trades_ignored():
    trades = [tr(5, 0.70, 500, "yes"),   # taker bought YES: hits YES asks, not our bid
              tr(6, 0.72, 500, "no")]    # sold into a better (higher) YES bid ahead of ours
    assert fill_time(quote(queue=0), trades) is None


def test_trades_outside_window_and_blocks_ignored():
    before = tr(-1, 0.60, 10, "no")
    after_tip = tr(121, 0.60, 10, "no")
    block = tr(30, 0.60, 10, "no", block=True)
    assert fill_time(quote(), [before, after_tip, block]) is None


def test_no_side_mirrors_prices():
    # NO bid at 0.75 <=> YES price 0.25. Taker buys YES (taker_side 'yes') at 0.24 -> NO price 0.76 > 0.75: ignored.
    # Taker buys YES at 0.26 -> NO price 0.74 < 0.75: through our level -> fill.
    q = quote(side="no", price=0.75, queue=10)
    trades = [tr(5, 0.24, 50, "yes"), tr(6, 0.26, 1, "yes")]
    assert fill_time(q, trades) == trades[1]["created_time"]


def test_unsorted_trades_processed_in_time_order():
    trades = [tr(9, 0.70, 1, "no"), tr(5, 0.70, 100, "no")]
    assert fill_time(quote(queue=100), trades) == trades[0]["created_time"]


from kalshi_edges.maker_quotes import (settled_result, score, maker_fee, stop_sample, bar_check,
                                       final_ready, progress, MAKER_BAR, END_DATE)


def test_settled_result():
    assert settled_result({"status": "finalized", "result": "yes"}) == "yes"
    assert settled_result({"status": "settled", "result": "no"}) == "no"
    assert settled_result({"status": "finalized", "result": "scalar"}) == "void"
    assert settled_result({"status": "closed", "result": ""}) is None
    assert settled_result({"status": "finalized", "result": "weird"}) is None


def test_score_filled_win_and_loss():
    q = {"side": "no", "price": 0.75}
    fee = maker_fee(0.75)
    assert fee == round(0.0175 * 0.75 * 0.25, 4)
    win = score(q, "2026-11-20T00:10:00Z", "no")
    assert win["filled"] is True and win["fee"] == fee
    assert abs(win["pnl"] - (1 - 0.75 - fee)) < 1e-9
    loss = score(q, "2026-11-20T00:10:00Z", "yes")
    assert abs(loss["pnl"] + (0.75 + fee)) < 1e-9


def test_score_unfilled_and_void():
    assert score({"side": "yes", "price": 0.7}, None, "yes") == \
        {"filled": False, "fill_ts": None, "result": "yes", "fee": None, "pnl": None}
    v = score({"side": "yes", "price": 0.7}, "2026-11-20T00:10:00Z", "void")
    assert v["filled"] is True and v["pnl"] == 0.0


def row(i, day, pnl, price=0.75, fee=0.0033, market="totals"):
    return {"ticker": f"T{i}", "side": "yes", "market": market, "game_date": day,
            "tip_time": f"{day}T23:30:00+00:00", "price": price, "fee": fee, "pnl": pnl,
            "filled": True, "result": "yes" if pnl > 0 else "no", "scored_at": "x", "queue_ahead": 5}


def test_stop_sample_cuts_at_day_of_nth_fill():
    rows = [row(i, f"2026-12-{1 + i // 100:02d}", 0.2) for i in range(350)]   # 100 fills per day
    s = stop_sample(rows, n=300)
    assert len(s) == 300                       # 300th fill lands on Dec 3, the cut keeps all of Dec 3 (= 300)
    rows2 = [row(i, f"2026-12-{1 + i // 120:02d}", 0.2) for i in range(350)]  # 120/day: 300th on Dec 3
    assert len(stop_sample(rows2, n=300)) == 350   # Dec 1-3 = 350 rows (Dec 3 has 110)


def test_stop_sample_end_date_cap():
    rows = [row(1, "2027-04-10", 0.2), row(2, "2027-04-12", 0.2)]
    assert [r["ticker"] for r in stop_sample(rows, n=300)] == ["T1"]


def test_bar_check_pass_and_fail():
    days = [f"2026-12-{d:02d}" for d in range(1, 31)] + [f"2027-01-{d:02d}" for d in range(1, 31)]
    good = []
    for k, d in enumerate(days):           # 5 fills/day at 0.75: every 3rd day 5 wins, else 4 wins 1 loss
        for j in range(5):                 # (days must differ, or the t-test has zero variance)
            win = j > 0 or k % 3 == 0
            good.append(row(k * 5 + j, d, 0.2467 if win else -0.7533))
    rep = bar_check(good)
    assert rep["n"] == 300 and rep["roi"] > 0.02 and rep["p"] < 0.025 and rep["passes"] is True
    bad = [dict(r, pnl=-0.7533 if i % 4 == 0 else 0.2467) for i, r in enumerate(good)]  # 75% hit at 0.75 -> ~-0.4%
    assert bar_check(bad)["passes"] is False
    assert bar_check(good[:200])["passes"] is False          # under min_n


def test_final_ready():
    assert final_ready(300, date(2026, 12, 1)) is True
    assert final_ready(10, date(2027, 4, 12)) is True
    assert final_ready(299, date(2027, 4, 11)) is False


def test_progress_hides_roi():
    rows = [row(1, "2026-12-01", 0.2), dict(row(2, "2026-12-01", 0.0), filled=False, pnl=None),
            dict(row(3, "2026-12-01", 0.0), scored_at=None, filled=None, pnl=None),
            dict(row(4, "2026-12-01", 0.0), result="void", filled=None, pnl=None)]
    p = progress(rows)["totals"]
    assert p == {"orders": 4, "scored": 3, "void": 1, "fill_rate": 1 / 3, "median_queue": 5, "n_filled": 1}
    assert "roi" not in p
