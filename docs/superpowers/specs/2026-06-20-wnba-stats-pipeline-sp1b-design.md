# WNBA Stats Pipeline (SP1b) — Design

**Date:** 2026-06-20
**Status:** Approved (design phase)
**Scope:** Sub-project 1b of the WNBA pivot. Lands WNBA **game logs + team defense** in league-separated `wnba_*` tables. No scoring.

## Context

The WNBA pivot is going to full parity, built **backend-first**, then the multi-sport UI (see `2026-06-20-multisport-ui-design.md`). Order: SP1a props (done) → **SP1b stats (this)** → SP2 backfill+calibration → SP3 scoring+grading → SP-UI. SP1b supplies the game logs + team defense the confidence model needs to eventually score WNBA props.

## Discovery spike (run from dev 2026-06-20; stats.nba.com reachable)

`nba_api` (LeagueID `wnba` = `'10'`), season `'2026'`:

- **Game logs** — `LeagueGameLog(league_id='10', season='2026', player_or_team_abbreviation='P')` returns ~2,350 player-game rows. Columns include `PLAYER_NAME`, `PLAYER_ID`, `TEAM_ID`, `TEAM_ABBREVIATION` (e.g. "NYL", "CON"), `GAME_DATE`, `MATCHUP` ("NYL vs. CON"), `WL`, `MIN`, `FG3M`, `REB`, `AST`, `STL`, `BLK`, `PTS`. **No NBA-static player map needed** — names + abbrs come directly from the endpoint.
- **Team defense** — `LeagueDashTeamStats(league_id_nullable='10', ..., Opponent)` returns ~15 teams with `OPP_*_RANK` columns (same as NBA). It carries `TEAM_ID` + `TEAM_NAME` but **NOT `TEAM_ABBREVIATION`**.
- **Pace** — `LeagueDashTeamStats(..., Advanced)` exposes `PACE`.

**The one gap** — defense rows lack `TEAM_ABBREVIATION` (NBA solves this via `nba_api.stats.static.teams`, which is NBA-only) — is solved for WNBA by **deriving `TEAM_ID → abbreviation` from the gamelog** (which has both). No hardcoded WNBA team list, no static dependency.

## Decisions (locked during brainstorming)

1. **Core stats only** — game logs + team defense (both spike-confirmed). DVP (`team_defense_vs_position`) + player positions are a deferred follow-up (their WNBA endpoint shapes were not probed).
2. **Separate `scripts/fetch_wnba_stats.py`**, NOT a `--league` branch in `fetch_nba_stats.py`. The NBA script is a flat top-level script bound to NBA-only statics and season format; a separate script keeps NBA byte-for-byte untouched and lets the new one be structured with pure, testable functions under a `main()` guard.
3. **Separate `wnba_*` tables** (consistent with SP1a) via additive `CREATE TABLE … LIKE` + grants.

## Architecture

### Migration (additive; SQL editor, per the DDL rule)

```sql
CREATE TABLE IF NOT EXISTS wnba_player_game_logs  (LIKE player_game_logs  INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_team_defense_stats (LIKE team_defense_stats INCLUDING ALL);
-- LIKE doesn't copy GRANTs:
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_player_game_logs, public.wnba_team_defense_stats TO service_role;
GRANT SELECT ON public.wnba_player_game_logs, public.wnba_team_defense_stats TO anon, authenticated;
```
No NBA table altered.

### `scripts/fetch_wnba_stats.py` (structured with pure helpers + `main()` guard)

- `gamelog_row_to_log(row)` (pure) — maps one `LeagueGameLog` row → `wnba_player_game_logs` row: `player_name←PLAYER_NAME`, `game_date←GAME_DATE` normalized to `YYYY-MM-DD`, `points←PTS`, `rebounds←REB`, `assists←AST`, `fg3m←FG3M`, `blocks←BLK`, `steals←STL`, `pra←PTS+REB+AST`, `minutes←MIN`, `is_home←` "vs." in `MATCHUP`, `matchup←MATCHUP`, `win←WL=='W'`, `nba_id←PLAYER_ID`.
- `build_team_abbr_map(rows)` (pure) — `TEAM_ID → TEAM_ABBREVIATION` from gamelog rows.
- `main()` — fetch gamelog (`league_id='10'`, season `'2026'`, `'P'`) → upsert `wnba_player_game_logs` on `(player_name, game_date)`; build the abbr map; fetch `LeagueDashTeamStats` Opponent (season ranks) + `last_n_games=15` (L15) + Advanced (pace), map via `RANK_COL_MAP` (`OPP_PTS_RANK→pts_rank`, …, `OPP_FG3M_RANK→fg3m_rank`) and the abbr map → upsert `wnba_team_defense_stats` on `team_abbreviation`. Reuses the Supabase upsert helper pattern from `fetch_nba_stats.py`.
- Uses the same browser-like `STATS_HEADERS` as the NBA script (stats.nba.com blocks bare cloud IPs).

### Workflow

A WNBA stats step in `daily-stats.yml`, `continue-on-error`, after the NBA stats steps: `python3 scripts/fetch_wnba_stats.py`. Isolated — a WNBA fault can't disturb the NBA pipeline or its freshness gate.

### Data flow

```
nba_api (LeagueID 10, season 2026) ─► fetch_wnba_stats.py ─► wnba_player_game_logs
                                                          └─► wnba_team_defense_stats
                          (NBA fetch_nba_stats.py → player_game_logs / team_defense_stats — unchanged)
```

## Error handling

- WNBA fetch failures isolated (`continue-on-error`, ordered after NBA).
- Reuse the NBA script's per-endpoint try/except + `time.sleep` rate-limit buffers.
- `gamelog_row_to_log` defends against missing/None numeric fields (coerce to 0).

## Testing

- **Pure units (pytest, `scripts/tests/`):** `gamelog_row_to_log(sample_row)` → correct mapped row (points, `pra`, `is_home`, `win`, date normalization); `build_team_abbr_map(rows)` → correct `TEAM_ID→abbr`.
- **Integration smoke (live; dev reaches stats.nba.com):** run `fetch_wnba_stats.py`; assert ~2,350 rows in `wnba_player_game_logs` and ~15 in `wnba_team_defense_stats` with `pace` populated; and that the NBA tables were not written.
- **NBA non-regression:** separate script + tables ⇒ NBA untouched; confirm NBA table counts unchanged after a WNBA run.

## Rollout

Migration via SQL editor → run `fetch_wnba_stats.py` (dev or runner) → verify counts → add the `continue-on-error` workflow step.

## Out of scope (SP1b)

DVP (`team_defense_vs_position`) + player positions (deferred follow-up); WNBA scoring / calibration / grading (SP2/SP3); UI (SP-UI). No change to NBA ingestion.
