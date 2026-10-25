# WNBA Grading Pipeline (SP2 — forward accumulation) — Design

**Date:** 2026-06-20
**Status:** Approved (design phase)
**Scope:** Start accumulating graded WNBA props via forward capture + grading, and deploy SP1a to turn capture on. No model scoring; the model-comparison backtest is deferred.

## Why forward accumulation (not historical backfill)

SP2 was intended as a historical backfill to backtest the NBA model on WNBA. That's blocked: the only source of historical prop **lines** is The Odds API (`lib/the-odds-api.ts`), whose key is **deactivated** (`401 DEACTIVATED_KEY` — billing). odds-api.io can't substitute — its settled events **drop the prop lines** post-settlement (0 retrievable). WNBA game-log *outcomes* exist (SP1b) but there are no historical *lines* to pair them with.

So we **accumulate forward**: capture live WNBA props daily, grade them against game-log outcomes, build `wnba_prop_grades` over the season. Once enough graded data exists, replay the NBA model over it to decide "reuse NBA model" vs "fit WNBA calibration" (deferred — not buildable until data accrues).

## Key insight: WNBA props are unscored, so the NBA snapshot/grade path won't capture them

The NBA `/api/grade` reads `prop_history` filtered to `confidence_label IS NOT NULL`, and the props-refresh snapshot **only writes enriched (scored) props to history**. WNBA props have no score, so as-is they'd never be snapshotted and never gradeable. Grading itself is pure (actual stat vs line) and needs no score — the only fix needed is to **snapshot unscored WNBA props** and **not filter on label when grading WNBA**.

## Decisions (locked during brainstorming)

1. **Forward accumulation**, not historical backfill (historical lines unavailable).
2. **SP2 = WNBA grading pipeline + deploy SP1a** (push `master` + `vercel --prod`) so live capture→snapshot→grade runs daily. The deploy also ships the held calibration-honest tiers (acknowledged).
3. **Snapshot unscored WNBA props** via a `LeaguePropConfig.snapshotUnscored` flag (NBA stays label-filtered).
4. **Grade is score-independent** — no WNBA scoring/enrich needed in SP2.

## Architecture

### Migration (additive; SQL editor, per the DDL rule)

```sql
CREATE TABLE IF NOT EXISTS wnba_prop_grades (LIKE prop_grades INCLUDING ALL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_prop_grades TO service_role;
GRANT SELECT ON public.wnba_prop_grades TO anon, authenticated;
```

### Snapshot fix (`lib/props-refresh.ts`)

Add `snapshotUnscored?: boolean` to `LeaguePropConfig`. In `fetchAndCacheFreshProps`, the "snapshot existing props to history" query drops the `.not('confidence_label','is',null)` filter **only when `cfg.snapshotUnscored`** is set. `LEAGUE_PROP_CONFIGS.wnba` sets it `true`; `.nba` leaves it falsy (behavior byte-for-byte unchanged). This puts unscored WNBA props into `wnba_prop_history` so they can be graded.

### WNBA grading (`/api/grade/wnba`)

Extract the `/api/grade` POST logic into a **league-parameterized helper** `lib/grade.ts` (`gradeLeague(req, cfg)`), with `cfg = { historyTable, logsTable, gradesTable, requireLabel }`:
- `gradeProp(histRow, logRow)` (pure) — DNP when `minutes < 5` (→ `hit: null`), else `hit = direction==='over' ? actual > line : actual < line`; returns `{ actual_value, hit }`.
- `gradeLeague` reads `cfg.historyTable` for the date (filtered to `confidence_label not null` **only if** `cfg.requireLabel`), loads `cfg.logsTable`, grades, dedups, upserts `cfg.gradesTable` on `game_date,player_name,stat_type,line,direction`.
- `app/api/grade/route.ts` (NBA) → `gradeLeague(req, { historyTable:'prop_history', logsTable:'player_game_logs', gradesTable:'prop_grades', requireLabel:true })` — identical behavior.
- New `app/api/grade/wnba/route.ts` → `gradeLeague(req, { historyTable:'wnba_prop_history', logsTable:'wnba_player_game_logs', gradesTable:'wnba_prop_grades', requireLabel:false })`.

### Workflow

A `continue-on-error` WNBA grade step in the daily cron, after the NBA grade: `curl … /api/grade/wnba`.

### Data flow

```
/api/props/wnba (SP1a, deployed) ─► wnba_props ──snapshot(unscored)──► wnba_prop_history
wnba_player_game_logs (SP1b) ─────────────────────────────────────────┐
/api/grade/wnba ──────────────────────────────────────────────────────┴─► wnba_prop_grades
                       (NBA path: prop_history + player_game_logs → prop_grades — unchanged)
```

## Error handling

- WNBA grade step is `continue-on-error`, after NBA — can't disturb the NBA pipeline.
- `gradeProp` treats missing logs / `<5` minutes as DNP (`hit: null`), mirroring NBA.
- WNBA grade runs harmlessly with 0 rows until a refresh→game→grade cycle has occurred.

## Testing

- **Pure units (vitest):** `gradeProp(hist, log)` — over hit/miss, under hit/miss, DNP (`minutes<5`→null), missing log→null. Config tests: `LEAGUE_PROP_CONFIGS.wnba.snapshotUnscored === true` (nba falsy); grade configs map to the right tables + `requireLabel` per league.
- **NBA non-regression:** `/api/grade` and the props snapshot keep identical behavior (call helpers with NBA config); full vitest + `next build` green; NBA `prop_grades` unaffected.
- **Live (post-deploy):** `/api/grade/wnba` returns 200 (grades 0 until history exists); after a WNBA refresh, `wnba_prop_history` populates; after a completed WNBA slate, `wnba_prop_grades` gets rows.

## Rollout

1. `wnba_prop_grades` migration (SQL editor).
2. Deploy: push `master` + `vercel --prod` (ships SP1a props + SP1b stats workflow + calibration tiers + SP2 grading).
3. Verify: WNBA refresh populates `wnba_props`/`wnba_prop_history`; NBA grading + counts unaffected.
4. Accumulate over the WNBA season.

## Deferred / out of scope (SP2)

The model-comparison backtest (replay NBA model over `wnba_prop_grades`, compare tier hit-rates, decide reuse vs custom calibration) — a separate task once data accrues. WNBA scoring/enrich (not needed to grade). UI (SP-UI). No change to NBA behavior.
