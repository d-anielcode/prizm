from kalshi_edges.study import (POCKET_IDS, band_of, build_trades, classify, pocket_stats,
                                discovery_pass, status_of, calibration, K)

def row(t, player="A B", stat="points", strike=20, bid=0.40, ask=0.42, vol=50, result="yes",
        gd="2025-12-01", season="2025-26"):
    return {"ticker": t, "player": player, "stat": stat, "strike": strike, "pretip_yes_bid": bid,
            "pretip_yes_ask": ask, "pretip_volume": vol, "result": result, "game_date": gd, "season": season}

def test_pocket_count_is_preregistered():
    assert K == len(POCKET_IDS) == 176

def test_band_edges():
    assert band_of(0.02) == ".02-.05" and band_of(0.0499) == ".02-.05"
    assert band_of(0.05) == ".05-.10" and band_of(0.98) == ".90-.98"
    assert band_of(0.01) is None and band_of(0.99) is None

def test_build_trades_sides_fees_pnl_and_position():
    rows = [row("a", strike=15), row("b", strike=20, result="no"), row("c", strike=25),
            row("d", stat="double_double", strike=1, bid=None, ask=0.30)]
    tr = {(t.ticker, t.side): t for t in build_trades(rows)}
    yes_b = tr[("b", "yes")]
    assert yes_b.price == 0.42 and yes_b.won is False
    assert abs(yes_b.pnl - -(0.42 + 0.07 * 0.42 * 0.58)) < 1e-9
    no_b = tr[("b", "no")]
    assert abs(no_b.price - 0.60) < 1e-9 and no_b.won is True
    assert tr[("a", "yes")].pos == "lowest" and yes_b.pos == "interior" and tr[("c", "yes")].pos == "top"
    assert tr[("d", "yes")].pos == "lowest" and ("d", "no") not in tr     # no bid -> no NO trade
    assert tr[("d", "yes")].spread == ">10"

def test_no_price_rounded_to_cents_before_banding():
    # 1 - 0.9 == 0.09999999999999998 in floats; unrounded it would band as .05-.10
    tr = {t.side: t for t in build_trades([row("e", bid=0.9, ask=0.92, result="no")])}
    assert tr["no"].price == 0.10 and band_of(tr["no"].price) == ".10-.20"
    assert "no|band:.10-.20" in classify(tr["no"])
    # string prices from PostgREST numerics are handled the same way
    tr = {t.side: t for t in build_trades([row("f", bid="0.8000", ask="0.8200", result="no")])}
    assert tr["no"].price == 0.20 and band_of(tr["no"].price) == ".20-.35"

def test_void_and_out_of_range_skipped():
    assert build_trades([row("v", result="void")]) == []
    assert [t.side for t in build_trades([row("x", bid=0.985, ask=0.99)])] == []

def test_classify_ids():
    t = build_trades([row("a", bid=0.07, ask=0.08, vol=0)])
    yes = next(x for x in t if x.side == "yes")
    assert classify(yes) == ["yes|band:.05-.10", "yes|stat:points", "yes|pos:lowest",
                             "yes|spread:<=3", "yes|vol:0", "yes|band:.05-.10|stat:points"]
    assert set(classify(yes)) <= set(POCKET_IDS)

def test_pocket_stats_halves_and_day_clustered_p():
    trades = build_trades([row(f"t{i}", gd=f"2025-12-{1 + i % 20:02d}", bid=0.10, ask=0.12,
                               result="no") for i in range(40)])
    no = [t for t in trades if t.side == "no"]          # all winners at .90
    s = pocket_stats(no)
    assert s["n"] == 40 and s["roi"] > 0 and s["roi_h1"] > 0 and s["roi_h2"] > 0 and s["p"] < 1e-6

def test_bars_and_status():
    good = {"n": 400, "roi": 0.05, "roi_h1": 0.04, "roi_h2": 0.06, "p": 1e-5}
    assert discovery_pass(good)
    assert not discovery_pass({**good, "p": 0.01})            # fails Bonferroni 0.05/176
    assert not discovery_pass({**good, "roi_h2": -0.01})
    assert status_of(good, {"n": 50, "roi": 0.1}, {"n": 0, "roi": 0}) == "discovery_pass"
    assert status_of(good, {"n": 120, "roi": -0.01}, {"n": 0, "roi": 0}) == "failed_confirmation"
    assert status_of(good, {"n": 120, "roi": 0.0}, {"n": 10, "roi": 0}) == "confirmed"
    assert status_of(good, {"n": 120, "roi": 0.0}, {"n": 300, "roi": 0.03}) == "live"
    assert status_of(good, {"n": 120, "roi": 0.0}, {"n": 300, "roi": 0.02}) == "failed_forward"
    assert status_of({**good, "n": 10}, {"n": 0, "roi": 0}, {"n": 0, "roi": 0}) == "rejected"

def test_calibration_rows():
    rows = [row("a", ask=0.12, result="yes"), row("b", ask=0.14, result="no"), row("c", ask=0.50, season="2026-27")]
    cal = {(c["season"], c["band"]): c for c in calibration(rows)}
    assert cal[("2025-26", ".10-.20")]["n"] == 2 and cal[("2025-26", ".10-.20")]["yes_rate"] == 0.5
    assert abs(cal[("2025-26", ".10-.20")]["mean_ask"] - 0.13) < 1e-9
