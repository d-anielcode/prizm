# Prediction Markets: full-ladder model picks

Date: 2026-11-11. Status: approved design, pending implementation plan.
Builds on: `2026-11-07-kalshi-calibration-study-design.md` and the Kalshi model picks
shipped 2026-11-11 (`lib/kalshi/model-picks.ts`, table `kalshi_model_picks`).

## Goal

Price every Kalshi rung for points, rebounds, assists, threes and PRA from the
sportsbook model, not only the ~35% of rungs that sit exactly on a sportsbook main
or alt line. No new model: the model's calibrated probability at the book line is
stretched across the ladder with a per-player distribution. Stretched rungs are
shown on the site only after a replay on 2025-26 passes a bar written here, and
stay subject to a forward record on 2026-27.

Out of scope: double-double and triple-double (no model score to anchor; own spec
later), game props, any change to the sportsbook model itself.

## Why this shape

- The confidence score is calibrated (`applyCalibration`) only on real book lines.
  Scoring "25+ points" as if a book posted 24.5 would feed off-line scores into a
  curve that never saw them, and could produce out-of-order ladders.
- `scripts/kalshi_edges/prob_model.py` (June 2026) already implements the
  calibrated mean-shift bridge: fit a distribution from game logs, solve one
  shift so P(over book line) equals the model's probability, read P(X >= N) at
  any strike. Monotone in N by construction.
- Data available on 2026-11-11: `kalshi_settled` 2025-26 holds ~61k settled
  points/rebounds/assists rungs (threes and PRA still backfilling);
  `prop_grades` has a stored model score for ~60% of them (~37k rungs).

## Bridge (one code path, live and replay)

New module `scripts/kalshi_edges/ladder_model.py`, pure functions:

1. **Anchor.** Inputs: the scored rows for one player/stat/game, each
   `(line, direction, confidence_score)`. Convert each to a calibrated probability
   with the existing `prizm_data.apply_calibration` over `lib/calibration-table.json`
   (per-stat lookup, global fallback), checked against the TS `applyCalibration`.
   The anchor line is the line with both directions scored whose
   P(over) is closest to 0.5; if no line has both, the line closest to 0.5 among
   the rest. Anchor P(over) = mean of cal(over) and 1 - cal(under) when both exist,
   else whichever exists (1 - cal(under) for an under-only line).
2. **Distribution.** `fit_distribution` on the player's last 40 games strictly
   before the game date (minimum 10 qualifying games), stat families as in
   `prob_model.py` (normal for points/PRA, negative binomial or Poisson for counts).
3. **Shift.** `solve_shift(dist, anchor_line, anchor_p)`. A clamped solve skips
   the player/stat.
4. **Rungs.** For every Kalshi rung of that player/stat/game:
   `model_p = prob_at_strike(dist, delta, strike)`; `exact = True` when ANY scored
   line (main or alt, either direction) sits at `strike - 0.5`. Exact rungs are left
   to the existing `matchPicks`, so a ticker is never both an exact and a stretched pick
   (they share `UNIQUE(ticker, side)`).

Skips (no games, clamped solve, no anchor) are counted by reason and logged, not
raised.

## Live

- New Python step `kalshi_model_rungs` in the pipeline `kalshi_live` phase (chain
  'kalshi', non-critical), after `kalshi_ingest` and before `kalshi_model_log`.
  Reads today's (ET) `kalshi_markets` rungs, `props` + `prop_alts` scored rows
  (any label, `confidence_score` not null) and `player_game_logs`; writes one row
  per ticker to `kalshi_model_rungs` (upsert on ticker).
- Table `kalshi_model_rungs`: ticker PK, player, stat, strike, game_date,
  model_p, anchor_line, anchor_p, delta, exact bool, commence_time (from the
  anchor props row, used by the 30-minute logging window), computed_at.
  Player names join via `find_edges.normalize_name` on both sides. Index on
  game_date. Explicit grants (service_role select/insert/update/delete,
  anon/authenticated select), RLS, `anon_read` policy.
- `kalshi_model_picks` gains `kind text not null default 'exact'`
  (`'exact' | 'stretched'`). Existing rows are `exact`.
- `lib/kalshi/model-picks.ts`: a second matcher `matchStretched(markets, rungs)`
  for non-exact rungs with `computed_at` within 45 minutes. Per rung, YES edge =
  model_p - (ask + fee), NO edge = (1 - model_p) - ((1 - bid) + fee); pick the
  side with positive edge, same filters as today (two-sided book, spread <= 10c,
  price 0.05-0.95, 0 < edge <= `MAX_MODEL_MARKET_GAP`). Tier is `STRETCH`.
  Exact-line picks keep using the existing `matchPicks` unchanged.
- The log route logs both kinds 30 minutes before tip, as today; the overnight
  `kalshi_model_grade` step grades both.
- Display flag `STRETCHED_VISIBLE` (constant in `lib/kalshi/model-picks.ts`,
  default false). False: stretched picks are logged and graded but appear only on
  Performance. True (set by a later commit if the replay passes): they also show on
  Home and Feed with a "stretched" tag.
- Performance splits the record by kind.

## Replay (discovery, 2025-26)

`scripts/kalshi_ladder_replay.py --report`, run once on the PC after the backfill
for the 5 stats is complete and the strike-fix SQL has run.

- **Window (amended 2026-11-15, before any replay result existed):** game dates
  2026-04-02..2026-06-13 only. A DB check found every `prop_history` / `prop_grades`
  score for 2025-12..2026-03-31 was written after the games (re-enrichment with
  season aggregates that include later games), so those scores may carry hindsight;
  from 2026-04-02 every snapshot was cached before tip. The window is 57 game days
  (~15.7k graded rungs before PRA), late regular season plus playoffs.
- Known population difference, recorded in the report: `prop_grades` holds main
  lines only, while live `exact` also counts alt lines, so some replay "stretched"
  rungs (mostly one step from the line) would be exact picks live. The per-distance
  rows show how much of the result comes from them; the forward record is the test
  of the live population.
- For each `kalshi_settled` 2025-26 rung (non-void, one of the 5 stats) with
  `prop_grades` rows for that player/stat/date: bridge with those rows as the
  anchor and game logs before that date only.
- Trades: non-exact rungs that pass the same filters as `matchStretched`, at
  `pretip_yes_ask` (YES) or `1 - pretip_yes_bid` (NO), fee `0.07 p (1-p)`.
  P&L win `1 - p - fee`, loss `-(p + fee)`; ROI = P&L / sum(p + fee).
- **Bar (pre-registered, one hypothesis):** n >= 300, ROI >= +3%, ROI > 0 in both
  chronological halves, one-sided t-test on per-day summed P&L p < 0.05.
- Reported, not gated: per-stat and per-distance-from-anchor rows; Brier of
  model_p vs Brier of the pre-tip mid on the same rungs; calibration curve of
  model_p vs realized YES rate; skip counts by reason.
- Caveat recorded in the report: `lib/calibration-table.json` was fit on
  2025-12-01..2026-11-06, which overlaps the replay, so the replay is discovery
  only; the forward record is the real test.
- Output `docs/kalshi-study/<date>-full-ladder-replay.md` + `.json`, committed
  whatever the result. No re-runs with changed filters or bars; any new idea is a
  new spec with a new forward test.

## Decision rules

- Replay passes: commit `STRETCHED_VISIBLE = true`.
- Replay fails: stretched picks stay paper-only (Performance), forward record keeps
  growing; reconsider at forward n >= 300.
- Forward (stretched kind, 2026-27, from ship date): if n >= 300 and ROI < 0,
  set `STRETCHED_VISIBLE = false` regardless of the replay.

## Error handling

- `kalshi_model_rungs` step: per-player failures are skips; a query or upsert error
  fails the step (non-critical, visible on `/status`).
- Site ignores rung rows older than 45 minutes: a dead step means no stretched
  picks, not stale ones.
- Replay refuses to run unless `kalshi_settled` 2025-26 has all 5 stats inside the
  replay window, with an earliest date on or before 2026-04-02.

## Testing

- pytest: Python calibration matches the TS lookup on fixed scores; anchor-line
  choice (both sides, one side, ties); ladder monotone in strike; `exact` flag;
  replay uses no game on or after the game date; trade/fee/P&L/ROI; bar logic
  incl. halves and t-test on a known example; skip counting.
- vitest: `matchStretched` side choice, filters, staleness cutoff; kind split in
  record helpers; `STRETCHED_VISIBLE` gating on Home/Feed.

## Success criteria

- `kalshi_model_rungs` fills every 15 minutes on game days, covering most rungs of
  players with a scored book line.
- Stretched picks are logged and graded nightly with `kind = 'stretched'`.
- The replay report is committed with the bar result stated plainly.
