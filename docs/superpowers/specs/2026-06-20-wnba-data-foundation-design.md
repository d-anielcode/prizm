# WNBA Data Foundation (SP1) — Design

**Date:** 2026-06-20
**Status:** Approved (design phase)
**Scope:** Sub-project 1 of 4 in the WNBA pivot. Data foundation only — **no WNBA picks/scoring**.

## Context: the WNBA pivot

Prizm is going **permanent multi-sport** (NBA + WNBA first-class, year-round; extensible later). It's the NBA offseason and the WNBA is live (~189 pending games on odds-api.io). The pivot is decomposed into four sub-projects, each its own spec → plan → build:

- **SP1 — League-aware data foundation** *(this spec)*: land live WNBA props + stats in league-separated storage. No scoring.
- **SP2 — WNBA backfill + calibration**: backfill the 2026 WNBA season (game logs via nba_api; graded props reconstructed from settled odds-api.io events) and fit a per-league calibration; validate model transfer.
- **SP3 — WNBA scoring live + grading**: league-aware scoring/calibration in `getLabel`; daily WNBA enrich + grade.
- **SP4 — UI**: league toggle; surface WNBA picks.

## Decisions (locked during brainstorming)

1. **Permanent multi-sport** — both leagues first-class.
2. **Separate `wnba_*` tables**, NOT a `league` column on shared tables. Rationale: the shared tables are read in ~50+ files (`player_game_logs` alone: 50; `prop_grades`: 27; `props`: 22). A league-column retrofit would require adding a `league='nba'` filter to every read site, and a single miss silently corrupts NBA scoring once WNBA rows coexist. Separate tables keep the **NBA code path 100% untouched** and make the migration purely additive — honoring the "no data loss / smooth transfer" priority.
3. **Backfill-first** (SP2), seeding from the **current 2026 WNBA season to date**. SP1 itself lands live data only.
4. **Sources confirmed:** `nba_api` supports WNBA via `LeagueID.wnba` ('10') for game logs + team defense; odds-api.io serves `usa-wnba` (live + settled events).

## Feasibility (verified)

- `nba_api` 1.11.4 is installed and exposes `LeagueID.wnba = '10'`; the same endpoints used for NBA accept the WNBA league id.
- odds-api.io returns live `usa-wnba` events (189) and settled WNBA events (sample: 5/day) — both live and historical props are reachable.
- stats.nba.com / stats.wnba.com are unreachable from dev IPs (the known cloud-IP block) but reachable from the GitHub runner, where the daily fetch runs.

## Architecture

### Migration — additive, NBA untouched

Create league-mirrored tables with `CREATE TABLE wnba_x (LIKE x INCLUDING ALL)` (copies columns, defaults, indexes, constraints — exact parity). SP1 creates the ingestion targets:

- `wnba_player_game_logs`
- `wnba_team_defense_stats`
- `wnba_team_defense_vs_position`
- `wnba_player_positions`
- `wnba_props`
- `wnba_prop_alts`

(`wnba_prop_grades` / `wnba_prop_history` / `wnba_prop_features` mirrors are created in SP2 when first written.) No NBA table, constraint, or index is altered. DDL runs via `supabase db push` / SQL editor (project rule — never REST).

### Ingestion — one codebase parameterized by league

- **`scripts/fetch_nba_stats.py`** gains `--league {nba,wnba}` (default `nba`). For `wnba` it passes `LeagueID.wnba` to the same `nba_api` endpoints and writes to the `wnba_*` tables via a `{league → table-name}` map. The NBA invocation is unchanged. Conflict targets are the same per-table keys, just against the `wnba_*` table.
- **`lib/odds-api.ts`** gains a WNBA event fetch (`sport=basketball&league=usa-wnba`, mirroring `fetchTodaysNBAEvents`; reuse `selectEarliestSlate` + `parsePropsFromEvent`).
- **Props route:** give the existing `fetchAndCacheFreshProps` an **optional league config** (odds-league slug + target table names) that **defaults to NBA**, so the NBA `/api/props` GET keeps calling it exactly as today (behavior unchanged). Expose the WNBA path via a sibling route `/api/props/wnba` that calls the same helper with the WNBA config → writes `wnba_props` / `wnba_prop_alts`. One implementation, NBA call site unchanged.

### Workflow

Add WNBA steps to the daily refresh (`fetch_nba_stats.py --league wnba`, then refresh WNBA props), placed **after** the NBA steps and marked `continue-on-error`, so a WNBA fault cannot disturb the NBA pipeline or its freshness gate.

### Data flow

```
nba_api (LeagueID 10)  ─► fetch_nba_stats.py --league wnba ─► wnba_player_game_logs / wnba_team_defense_stats / wnba_team_defense_vs_position / wnba_player_positions
odds-api.io (usa-wnba) ─► /api/props?league=wnba           ─► wnba_props / wnba_prop_alts
                          (NBA path → props / player_game_logs / ... unchanged)
```

### No picks in SP1

SP1 lands WNBA props + stats only. No enrich/scoring/grading for WNBA. WNBA props sit unscored until SP2/SP3.

## Error handling

- WNBA ingestion failures are isolated (`continue-on-error`; ordered after NBA).
- `fetch_nba_stats.py` reuses its existing per-endpoint error handling; the `{league → table}` map raises on an unknown league rather than defaulting.
- odds-api.io WNBA fetch reuses the existing tolerant paging (throws only if the league query itself errors).

## Testing

- **Pure units:** the `{league → table-name}` map (Python + TS) — `nba`→`player_game_logs`, `wnba`→`wnba_player_game_logs`, etc., and an unknown league raises. WNBA odds-api event parse against a recorded `usa-wnba` fixture.
- **Integration smoke (live — WNBA season is on):** `fetch_nba_stats.py --league wnba` lands rows in `wnba_player_game_logs` / `wnba_team_defense_stats` (and not the NBA tables); `/api/props?league=wnba` populates `wnba_props`.
- **NBA non-regression:** existing vitest + pytest suites stay green; capture NBA table row counts before/after a WNBA ingestion run and assert they are unchanged (proves the parameterized path never writes NBA tables).

## Rollout

DDL via `supabase db push` / SQL editor → deploy code (`vercel --prod` for the props route; fetch script + workflow run from `master` on the runner) → verify: WNBA stats + props land in `wnba_*`, NBA row counts unchanged, NBA cron still green.

## Out of scope (SP1)

WNBA scoring/enrich, calibration, grading, historical backfill (SP2/SP3), and any UI (SP4). No `league` column on shared tables. No changes to NBA ingestion behavior.
