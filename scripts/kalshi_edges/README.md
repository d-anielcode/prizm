# Kalshi NBA Prop Edge Finder (read-only)

Compares Prizm's model probability against Kalshi NBA player-prop ask prices and
prints a ranked edge table. No auth, no orders. See the design spec at
`docs/superpowers/specs/2026-06-08-kalshi-edge-finder-design.md`.

## Run

    cd /c/Users/dcho0/nbaiqproject
    set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a
    cd scripts
    python3 -m kalshi_edges.find_edges --min-edge 0.03 --min-volume 50

Use `python3` (Python 3.14); `py -3.13` lacks pytest/this venv's deps.

## Flags

- `--game-date YYYY-MM-DD`  restrict the Prizm slate to games commencing that day
                            (default: today). The `props` table is the live slate
                            keyed by `commence_time`; there is no `game_date` column.
- `--min-edge`              minimum |model_p - yes_ask| to display (default: 0.03)
- `--min-volume`            minimum Kalshi contract volume (default: 0)
- `--stat`                  restrict to one stat_type (e.g. `points`)
- `--calibration`          path to calibration-table.json (default: repo `lib/`)

## How it works

1. Fit a per-player distribution (negative binomial for counts, normal for
   points/PRA) to `player_game_logs`.
2. Anchor its mean to Prizm's calibrated P(over) at the sportsbook line
   (the `props` table's `confidence_score` -> `lib/calibration-table.json`).
3. Evaluate P(X >= strike) at Kalshi's milestone strike.
4. Edge = model probability - Kalshi yes_ask.

## Output flags

- `factored`    anchored to a matching Prizm prop (full confidence-score coupling)
- `unfactored`  no matching Prizm prop; pure log-based distribution
- `clamped`     the score implied a probability unreachable by the mean shift
- `ambiguous`   multiple raw names normalized to the same player; excluded from anchoring

## Kalshi schema notes (verified live 2026-06-08)

`market_data.parse_market` reads the **real** Kalshi market fields:
- Prices are decimal strings: `yes_ask_dollars` / `yes_bid_dollars` ("0.6500").
- Volume: `volume_fp`.
- Milestone strike is structured: `strike_type` + `floor_strike` / `cap_strike`
  (preferred over parsing "30+" from the title).

## PENDING: game-day reconciliation

Kalshi has **no single umbrella "NBA props" series**. Single-game player props are
listed per game-day under per-player/per-stat series tickers, usually only a few
hours before tip. `market_data.PROP_SERIES` is therefore **empty** until populated
on an NBA game day, and `fetch_props()` returns nothing until then.

To finish reconciliation on a game day with live props:

1. Discover the open NBA prop series, e.g. scan events/markets for basketball
   single-game props and note their `series_ticker` values.
2. Add them to `PROP_SERIES` in `market_data.py`.
3. Confirm the single-game title format feeds `_extract_player` / `_classify_stat`
   correctly (the player/stat split is the one piece still awaiting live
   confirmation; strike/price/volume fields are already confirmed). Run:
   `python3 -c "from kalshi_edges import market_data as m; print([m.parse_market(r) for r in m.fetch_markets('<SERIES>')][:10])"`
   and adjust `STAT_KEYWORDS` / `_CUE_RE` if real titles differ from the fixture.
4. Update `scripts/tests/fixtures/kalshi_markets.py` to a real captured row and
   keep `tests/test_kalshi_market_data.py` green.

The Prizm side (props, logs, calibration, the mean-shift bridge) is fully wired and
was validated end-to-end against the real 2026-06-09 slate via synthetic markets.

## Paper trading (book-price scanner)

Fair value = DraftKings/FanDuel odds with the vig removed (minus a measured 1.8-pt
over bias), mapped to each Kalshi "N+" rung via the per-player distribution;
edge = fair p − ask − Kalshi fee (0.07·p·(1−p)). Only two-sided book lines and
rungs within one step of the book line are traded.
Spec: `docs/superpowers/specs/2026-10-21-kalshi-book-price-scanner-design.md`.

    cd scripts
    python3 -m kalshi_edges.run_paper scan --dry-run   # print candidates only
    python3 -m kalshi_edges.run_paper scan             # write paper trades
    python3 -m kalshi_edges.run_paper clv              # store pre-tip mid for games tipping within 30 min
    python3 -m kalshi_edges.run_paper grade            # settle from Kalshi results
    python3 -m kalshi_edges.run_paper report           # ROI, CLV, go-live bar

Ledger: Supabase `kalshi_paper_trades`. Log: `.logs/kalshi-paper.log`.
Windows tasks (all `pythonw.exe -m kalshi_edges.run_paper ...` in `scripts/`):
"Prizm Kalshi scan" 3:45 PM, "Prizm Kalshi CLV" 3:55 PM every 30 min for 4 h,
"Prizm Kalshi grade" 9:00 AM. Start-when-available, so a sleeping PC catches up.

Go-live bar (pre-registered): ≥300 graded trades, ROI ≥ +3% after fees, both
halves positive, mean CLV > 0. Below it: stay paper-only; don't re-tune on the same sample.
