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


from kalshi_edges.study import evaluate, render_report

def test_evaluate_splits_seasons_and_forward():
    # bid .15 -> NO costs .85 (band .80-.90); note 1 - .10 == .90 would land in .90-.98
    rows = [row(f"d{i}", gd=f"2025-12-{1 + i % 25:02d}", bid=0.15, ask=0.17, result="no") for i in range(400)]
    rows += [row(f"c{i}", gd=f"2026-10-{20 + i % 10:02d}", season="2026-27", bid=0.15, ask=0.17, result="no") for i in range(150)]
    fwd = [{"pocket_id": "no|band:.80-.90", "pnl": 0.08, "price": 0.88, "fee": 0.007, "won": True}]
    pockets = {p["id"]: p for p in evaluate(rows, fwd)}
    p = pockets["no|band:.80-.90"]
    assert p["disc_n"] == 400 and p["conf_n"] == 150 and p["fwd_n"] == 1 and p["status"] == "confirmed"
    assert pockets["yes|band:.10-.20"]["status"] == "rejected"
    assert len(pockets) == 176

def test_render_report_mentions_counts():
    rows = [row("a")]
    md = render_report(evaluate(rows, []), calibration(rows), n_rows=1)
    assert "176 pockets" in md and "0 passed discovery" in md


# --- review fixes -----------------------------------------------------------
import math
from kalshi_edges.study import STATS, discovery_complete, fee_ceil_roi, vol0_share

def _full_disc(earliest="2025-11-20"):
    return [row(f"s{i}", stat=s, gd=earliest if i == 0 else "2026-01-10") for i, s in enumerate(STATS)]

def test_discovery_complete_ok():
    ok, reason = discovery_complete(_full_disc() + [row("c", season="2026-27", gd="2026-10-25")])
    assert ok and reason == ""

def test_discovery_complete_missing_stat():
    rows = [r for r in _full_disc() if r["stat"] != "triple_double"]
    ok, reason = discovery_complete(rows)
    assert not ok and "triple_double" in reason

def test_discovery_complete_late_start():
    ok, reason = discovery_complete(_full_disc(earliest="2025-12-01"))
    assert not ok and "2025-12-01" in reason
    assert discovery_complete(_full_disc(earliest="2025-11-25"))[0]

def test_discovery_complete_no_rows():
    ok, reason = discovery_complete([row("c", season="2026-27")])
    assert not ok and reason

# A pocket that passes discovery: NO at .85 (bid .15) wins every time in 2025-26.
DISC = [row(f"d{i}", gd=f"2025-12-{1 + i % 25:02d}", bid=0.15, ask=0.17, result="no") for i in range(400)]
PID = "no|band:.80-.90"

def conf_rows(n, result):
    return [row(f"c{result}{i}", gd=f"2026-10-{20 + i % 10:02d}", season="2026-27", bid=0.15, ask=0.17,
                result=result) for i in range(n)]

def fwd(n, won):
    return [{"pocket_id": PID, "price": 0.85, "fee": 0.0089, "won": won,
             "pnl": (1 - 0.85 - 0.0089) if won else -(0.85 + 0.0089)} for _ in range(n)]

def pocket(rows, fw=(), previous=None, now="2026-11-08T00:00:00+00:00"):
    return {p["id"]: p for p in evaluate(rows, list(fw), previous=previous, now=now)}[PID]

def test_conf_verdict_undecided_below_min_n():
    p = pocket(DISC + conf_rows(50, "no"))
    assert p["conf_verdict"] is None and p["conf_decided_at"] is None and p["status"] == "discovery_pass"

def test_conf_pass_frozen_against_later_worse_sample():
    p1 = pocket(DISC + conf_rows(120, "no"), now="2026-11-08T00:00:00+00:00")
    assert p1["conf_verdict"] == "pass" and p1["conf_decided_at"] == "2026-11-08T00:00:00+00:00"
    assert p1["status"] == "confirmed"
    later = DISC + conf_rows(120, "no") + conf_rows(400, "yes")          # now deeply negative
    p2 = pocket(later, previous={PID: p1}, now="2026-11-15T00:00:00+00:00")
    assert p2["conf_roi"] < 0                                           # current number still reported
    assert p2["conf_verdict"] == "pass" and p2["conf_decided_at"] == "2026-11-08T00:00:00+00:00"
    assert p2["status"] == "confirmed"

def test_conf_fail_frozen_against_later_better_sample():
    p1 = pocket(DISC + conf_rows(120, "yes"))
    assert p1["conf_verdict"] == "fail" and p1["status"] == "failed_confirmation"
    p2 = pocket(DISC + conf_rows(120, "yes") + conf_rows(2000, "no"), previous={PID: p1})
    assert p2["conf_roi"] > 0 and p2["conf_verdict"] == "fail" and p2["status"] == "failed_confirmation"

def test_fwd_verdict_frozen_both_ways():
    rows = DISC + conf_rows(120, "no")
    p1 = pocket(rows, fwd(300, True), now="2026-12-01T00:00:00+00:00")
    assert p1["fwd_verdict"] == "pass" and p1["status"] == "live"
    p2 = pocket(rows, fwd(300, True) + fwd(600, False), previous={PID: p1})
    assert p2["fwd_roi"] < 0 and p2["fwd_verdict"] == "pass" and p2["status"] == "live"
    assert p2["fwd_decided_at"] == "2026-12-01T00:00:00+00:00"
    q1 = pocket(rows, fwd(300, False))
    assert q1["fwd_verdict"] == "fail" and q1["status"] == "failed_forward"
    q2 = pocket(rows, fwd(300, False) + fwd(3000, True), previous={PID: q1})
    assert q2["fwd_roi"] > 0 and q2["fwd_verdict"] == "fail" and q2["status"] == "failed_forward"

def test_fwd_undecided_below_min_n():
    p = pocket(DISC + conf_rows(120, "no"), fwd(299, True))
    assert p["fwd_verdict"] is None and p["status"] == "confirmed"

def test_calibration_mean_mid():
    rows = [row("a", bid=0.10, ask=0.12), row("b", bid=None, ask=0.14), row("c", bid=0.12, ask=0.16),
            row("d", bid=None, ask=0.50)]
    cal = {(c["season"], c["band"]): c for c in calibration(rows)}
    assert abs(cal[("2025-26", ".10-.20")]["mean_mid"] - (0.11 + 0.14) / 2) < 1e-9
    assert cal[("2025-26", ".50-.65")]["mean_mid"] is None

def test_fee_ceil_roi_and_vol0_share():
    tr = [t for t in build_trades([row("a", bid=0.48, ask=0.50, result="yes", vol=0),
                                   row("b", bid=0.48, ask=0.50, result="no", vol=5)]) if t.side == "yes"]
    # fee at .50 = .0175 -> rounds up to .02 per contract
    staked = 2 * (0.50 + 0.02)
    assert abs(fee_ceil_roi(tr) - ((1 - 0.52) - 0.52) / staked) < 1e-9
    assert vol0_share(tr) == 0.5
    # exact-cent fees are not bumped by float noise: .07*.1*.9 = .0063 -> .01
    t10 = [t for t in build_trades([row("c", bid=0.08, ask=0.10, result="no")]) if t.side == "yes"]
    assert abs(fee_ceil_roi(t10) - -1.0) < 1e-9

def test_render_report_adds_fee_ceil_and_vol0_for_passed():
    rows = DISC + conf_rows(120, "no")
    pockets = evaluate(rows, [])
    md = render_report(pockets, calibration(rows), len(rows), build_trades(rows))
    line = next(l for l in md.splitlines() if l.startswith(f"| {PID} |"))
    t = [x for x in build_trades(DISC) if x.side == "no"]
    assert f"{fee_ceil_roi(t):+.1%}" in line and "0%" in line          # vol 50 -> no tier-0 trades
    assert "fee ceil" in md


def test_ladder_position_counts_void_rungs():
    # 15 is void but was a priced rung: 20 is interior, not the lowest rung
    rows = [row("a", strike=15, result="void"), row("b", strike=20), row("c", strike=25)]
    tr = {t.ticker: t for t in build_trades(rows) if t.side == "yes"}
    assert "a" not in tr and tr["b"].pos == "interior" and tr["c"].pos == "top"
