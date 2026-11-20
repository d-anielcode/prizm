# Ordered Daily Pipeline + Job Log — Design

Date: 2026-10-25 · Status: approved in brainstorming, pending spec review

## Why

The daily pipeline is spread over three schedulers with no ordering between them:

- **Vercel**: 20 Hobby crons (`vercel.json`, all slots used). Hobby fires each
  cron anywhere within its scheduled hour.
- **GitHub**: `.github/workflows/daily-stats.yml` at 09:00 and 15:00 UTC, repeating
  most Vercel steps and owning a few alone (streak pick, WNBA props/grading,
  3PM zone sim, parlay pass 2).
- **User's PC**: Windows tasks for the NBA defense/positions refresh
  (stats.nba.com blocks cloud IPs) and the Kalshi paper scan/CLV/grade.

Steps depend on order; nothing enforces it. In one week this produced two
history-breaking bugs (results summarized the wrong slate; parlays graded before
game logs existed → every parlay voided all season). Props are refreshed ~6×/day
(Odds API credits) and parlays are rebuilt by two systems (feed spam). Failures are
silent: no record of what ran, no alert.

## Goals

1. Steps run **in a guaranteed order**, each waits for its inputs, and missed or
   failed steps are visible.
2. One record of every step run (`job_runs`) and a `/status` page.
3. A failed step or a data-coverage drop **emails the user** (GitHub failed-run email).
4. Odds refreshed 3×/day (overnight, midday, pre-tip) instead of ~6.

Non-goals: moving the PC-only jobs off the PC, changing what any step computes,
real-time alerting channels (Discord/push).

## Architecture

A Python runner, `scripts/pipeline/`, invoked by GitHub Actions workflows. It calls
the **existing** Vercel API routes over HTTPS (`$VERCEL_APP_URL`, `Authorization:
Bearer $CRON_SECRET`) with explicit dates, and runs a few Python scripts as
subprocesses. Routes keep their logic; only scheduling and checking move.

| Unit | Responsibility |
|---|---|
| `scripts/pipeline/steps.py` | Step definitions as data: name, kind (`http`/`python`), endpoint or command, params builder (date), `critical` flag, `chain`, optional readiness check and coverage check |
| `scripts/pipeline/phases.py` | Ordered step lists per phase: `overnight`, `midday`, `pretip`, `weekly` |
| `scripts/pipeline/runner.py` | Run a phase: for each step write a `job_runs` row, call, retry, check, record; chain/critical semantics; exit code |
| `scripts/pipeline/checks.py` | Readiness + coverage checks (pure functions over fetched counts / step responses) |
| `scripts/pipeline/store.py` | Supabase REST: insert/update `job_runs`; count queries used by checks |
| `scripts/pipeline/__main__.py` | CLI: `python -m pipeline <phase> [--date YYYY-MM-DD] [--dry-run]` |
| `.github/workflows/pipeline-*.yml` | Schedules + `workflow_dispatch`; run the CLI |
| `app/status/page.tsx` | Read-only status page over `job_runs` + freshness queries |
| `supabase/migrations/20261025120000_job_runs.sql` | Table (applied by user in SQL editor) |

## Phases

All dates are **ET game dates**. `today` = ET date at run time; `yesterday` = today−1.

**overnight** — workflow cron `0 9 * * *` (05:00 ET; all games final).
- Chain `results` (for `yesterday`): `gamelogs` (`/api/gamelogs?days=3`) →
  readiness: if `prop_history` has rows for yesterday, `player_game_logs` must have
  rows for yesterday; if not, re-run `gamelogs` up to 3× with 10-min waits, then
  fail → `grade` (`/api/grade`) → `grade_wnba` (`/api/grade/wnba`, skipped if no
  WNBA history yesterday) → `feed_grade` (`/api/feed/grade`) → `results`
  (`/api/results?force=true`, re-summarizes last 3 days) → `seasonstats`
  (`/api/seasonstats`) → `perf_snapshot` (`/api/performance-snapshot`).
- Chain `slate` (for `today`): `props` (`/api/props?refresh=true`) → `props_wnba`
  (`/api/props/wnba?refresh=true`, best-effort) → `wnba_stats` (python
  `fetch_wnba_stats.py`, best-effort) → `sim_3pm` (python `sim_3pm.py`,
  best-effort) → `enrich` (`/api/enrich?force=true`) → `streak`
  (`/api/feed/generate/streak`) → `parlay` (`/api/feed/generate/parlay`).
- The `slate` chain runs even if `results` failed (stale data beats no slate); the
  run still fails overall.

**midday** — cron `0 16 * * *` (noon ET): `props` → `enrich` → `parlay_pass2`
(`/api/feed/generate/parlay?pass=2`).

**pretip** — cron `*/30 15-23,0-1 * * *`. The runner first looks up today's first
`commence_time` from `props`; it proceeds only if `0 < first_tip − now ≤ 75 min` and
no `pretip` run for today has status `ok`. Otherwise it exits 0 with one `skipped`
row. Steps: `lineups` (`/api/lineups/fetch`) → `props` → `enrich` → `snapshot`
(`/api/props/snapshot`).

**weekly** — cron `0 10 * * 0`: `player_bias` (`/api/player-bias?action=analyze`)
→ `opponent_leaks` (`/api/opponent-leaks?action=analyze`). The existing
`weekly-diagnostic.yml` and `weekly-retrain.yml` stay as they are.

GitHub cron start can lag 5–30 min; ordering inside a run is what matters. Every
phase also has `workflow_dispatch` (re-run with one click, optional `date` input).

## Step execution

For each step, in order:
1. Insert `job_runs` row `status='running'`.
2. If the step's chain already failed on a `critical` step → mark `skipped`.
3. Run readiness check (if any). Not ready → `failed` with the reason.
4. Call: HTTP GET with a 300 s timeout (or subprocess for `python`). Retry up to 2
   times on timeout / HTTP 5xx / connection error, 30 s backoff. 4xx is not retried.
5. Parse the JSON response; run the coverage check (if any).
6. Update the row: `ok` / `failed`, `http_status`, `duration_ms`, `summary` (first
   2 KB of the response JSON), `error`.

`critical` steps (failure stops the rest of their chain): `gamelogs`, `grade`,
`props`, `enrich`. Others are best-effort: they fail their row and the run but the
chain continues. Exit code is non-zero if any step failed → GitHub emails the user.

## Data checks

- `enrich` (every phase): on game days (props for today exist) the response must
  show `enriched > 0`; `teamSources.none / (roster+logs+none) ≤ 0.05`;
  `espnSpreadsLoaded ≥ 0.8 × games today`.
- `results` chain end (overnight): yesterday has ≥1 `prop_grades` row and ≥1
  `prop_results` row when yesterday had games.
- `defense_fresh` (overnight, final step, NBA regular season Oct 20–Apr 20):
  newest `team_defense_stats.fetched_at` ≤ 48 h old (replaces
  `scripts/check_data_freshness.py` in CI; the PC task keeps writing the data).

## `job_runs` table

```sql
CREATE TABLE IF NOT EXISTS job_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid        NOT NULL,           -- one pipeline invocation
  phase       text        NOT NULL,           -- overnight|midday|pretip|weekly|pc
  step        text        NOT NULL,
  game_date   date,
  source      text        NOT NULL DEFAULT 'github',  -- github|pc|manual
  status      text        NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  http_status integer,
  summary     jsonb,
  error       text
);
CREATE INDEX IF NOT EXISTS job_runs_started_idx ON job_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_phase_date_idx ON job_runs (phase, game_date);
GRANT SELECT, INSERT, UPDATE ON public.job_runs TO service_role;
GRANT SELECT ON public.job_runs TO anon, authenticated;
```

PC tasks (`scripts/run_local_defense.py`, `scripts/kalshi_edges/run_paper.py`) write
one row per step with `source='pc'`, `phase='pc'`, reusing `store.py`.

## `/status` page

Server-rendered, `revalidate = 60`:
- Last run of each phase: start time, overall status, each step with status,
  duration and error (expandable summary).
- 7-day grid: rows = phases (+ PC jobs), columns = days, cell = ok/failed/skipped/none.
- Freshness tiles: newest `player_game_logs.game_date`, newest `prop_grades`
  date, newest `props.cached_at`, newest `team_defense_stats.fetched_at`, newest
  `kalshi_paper_trades.scanned_at`.
- Linked from the nav (small, after Performance).

## Rollout

1. Merge runner, workflows (scheduled but **enabled**), `/status`; user applies the
   `job_runs` migration.
2. `workflow_dispatch` each phase once with `--dry-run`, then for real.
3. Run alongside the existing Vercel crons and `daily-stats.yml` for one full day;
   compare `job_runs` with today's data (steps are idempotent, so double runs are safe).
4. Remove every cron from `vercel.json` and delete `daily-stats.yml`.

## Error handling

- Network/5xx: retried (see above). Runner itself crashing: workflow fails → email.
- Supabase unreachable for `job_runs` writes: log to stdout and continue the step
  (logging must not block the pipeline); the run is marked failed at the end.
- A step hanging: per-call timeout 300 s; workflow `timeout-minutes: 60`.
- Overlapping runs: workflow `concurrency: pipeline-<phase>` (no parallel runs of
  the same phase).

## Testing

pytest in `scripts/tests/test_pipeline_*.py` with a fake HTTP client and fake store:
- step order per phase; chain skip after a critical failure; best-effort failure
  continues; exit code.
- retry on 5xx/timeout, no retry on 4xx.
- readiness: waits/retries `gamelogs`, fails after 3 attempts; passes when logs exist.
- coverage checks: pass/fail boundaries (5% teams, 80% spreads, enriched > 0).
- pretip gate: before window → skipped; inside window → runs; already ok today → skipped.
- `job_runs` rows: running → ok/failed with fields set.
- `--dry-run` makes no HTTP calls and writes nothing.
CI (`ci.yml`) already runs `scripts/tests`.
