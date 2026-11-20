# Ordered Daily Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 20 Vercel crons + the `daily-stats` workflow with one ordered, logged, checked pipeline run from GitHub Actions.

**Architecture:** `scripts/pipeline/` (Python package) defines steps as data, runs a phase in order against the existing Vercel API routes (HTTPS + `CRON_SECRET`), records each step in Supabase `job_runs`, and exits non-zero on any failure so GitHub emails the user. A `/status` page reads `job_runs`.

**Tech Stack:** Python 3.12 + `requests` (GitHub runner), pytest, Supabase REST, Next.js 16 server component.

**Spec:** `docs/superpowers/specs/2026-10-25-ordered-daily-pipeline-design.md`

**Conventions:** tests run from `scripts/`: `python3 -m pytest tests/test_pipeline_*.py -q` (conftest puts `scripts/` on `sys.path`). Commit per task, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. CI (`.github/workflows/ci.yml`) runs all tests on push.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/pipeline/__init__.py` | package marker |
| `scripts/pipeline/checks.py` | pure readiness/coverage/gate functions |
| `scripts/pipeline/steps.py` | `Step` dataclass |
| `scripts/pipeline/phases.py` | ordered step lists per phase |
| `scripts/pipeline/store.py` | Supabase REST: `job_runs` writes + count/lookup queries |
| `scripts/pipeline/http.py` | Vercel route client (GET with secret, timeout) |
| `scripts/pipeline/runner.py` | `run_phase()` — order, retries, chains, checks, logging |
| `scripts/pipeline/__main__.py` | CLI |
| `scripts/tests/test_pipeline_checks.py`, `test_pipeline_phases.py`, `test_pipeline_runner.py` | tests |
| `supabase/migrations/20261025120000_job_runs.sql` | table |
| `.github/workflows/pipeline-overnight.yml`, `-midday.yml`, `-pretip.yml`, `-weekly.yml` | schedules |
| `app/status/page.tsx` | status page |
| `components/` nav (existing layout) | add Status link |
| `scripts/run_local_defense.py`, `scripts/kalshi_edges/run_paper.py` | write `job_runs` rows (source `pc`) |

---

### Task 1: Pure checks

**Files:** Create `scripts/pipeline/__init__.py` (empty), `scripts/pipeline/checks.py`; Test `scripts/tests/test_pipeline_checks.py`

- [ ] **Step 1: failing tests**

```python
# scripts/tests/test_pipeline_checks.py
from datetime import datetime, timedelta, timezone
from pipeline.checks import (enrich_coverage, results_present, defense_fresh,
                             in_pretip_window, logs_ready, wnba_offseason)

NOW = datetime(2026, 11, 3, 21, 0, tzinfo=timezone.utc)

def test_enrich_ok():
    r = {'enriched': 400, 'teamSources': {'roster': 150, 'logs': 3, 'none': 2}, 'espnSpreadsLoaded': 9}
    assert enrich_coverage(r, games_today=10) is None

def test_enrich_no_props_on_game_day():
    assert 'enriched' in enrich_coverage({'enriched': 0}, games_today=5)

def test_enrich_no_games_is_fine():
    assert enrich_coverage({'enriched': 0}, games_today=0) is None

def test_enrich_team_coverage_boundary():
    ok = {'enriched': 1, 'teamSources': {'roster': 95, 'logs': 0, 'none': 5}, 'espnSpreadsLoaded': 10}
    bad = {'enriched': 1, 'teamSources': {'roster': 94, 'logs': 0, 'none': 6}, 'espnSpreadsLoaded': 10}
    assert enrich_coverage(ok, 10) is None
    assert 'team' in enrich_coverage(bad, 10)

def test_enrich_spread_boundary():
    base = {'enriched': 1, 'teamSources': {'roster': 10, 'logs': 0, 'none': 0}}
    assert enrich_coverage({**base, 'espnSpreadsLoaded': 8}, 10) is None
    assert 'spread' in enrich_coverage({**base, 'espnSpreadsLoaded': 7}, 10)

def test_results_present():
    assert results_present(had_games=False, grades=0, results=0) is None
    assert results_present(had_games=True, grades=10, results=4) is None
    assert 'grades' in results_present(had_games=True, grades=0, results=4)
    assert 'results' in results_present(had_games=True, grades=10, results=0)

def test_defense_fresh_in_season_and_offseason():
    assert defense_fresh((NOW - timedelta(hours=47)).isoformat(), NOW) is None
    assert 'old' in defense_fresh((NOW - timedelta(hours=49)).isoformat(), NOW)
    july = datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert defense_fresh((july - timedelta(days=30)).isoformat(), july) is None
    assert 'no defense' in defense_fresh(None, NOW)

def test_pretip_window():
    tip = NOW + timedelta(minutes=60)
    assert in_pretip_window(tip, NOW, already_ok=False) is True
    assert in_pretip_window(NOW + timedelta(minutes=80), NOW, already_ok=False) is False
    assert in_pretip_window(NOW - timedelta(minutes=5), NOW, already_ok=False) is False
    assert in_pretip_window(tip, NOW, already_ok=True) is False
    assert in_pretip_window(None, NOW, already_ok=False) is False

def test_logs_ready():
    assert logs_ready(history_rows=0, log_rows=0) is True   # no games -> nothing to wait for
    assert logs_ready(history_rows=500, log_rows=0) is False
    assert logs_ready(history_rows=500, log_rows=200) is True

def test_wnba_offseason():
    assert wnba_offseason(datetime(2026, 11, 3)) is True
    assert wnba_offseason(datetime(2026, 6, 3)) is False
```

- [ ] **Step 2:** `python3 -m pytest tests/test_pipeline_checks.py -q` → FAIL (`ModuleNotFoundError: pipeline`)

- [ ] **Step 3: implement**

```python
# scripts/pipeline/checks.py
"""Pure readiness / coverage / gate checks. Each coverage check returns None when OK,
or a short failure message."""
from datetime import datetime, timedelta

MAX_UNRESOLVED_TEAM_SHARE = 0.05
MIN_SPREAD_SHARE = 0.80
DEFENSE_MAX_AGE = timedelta(hours=48)
PRETIP_LEAD = timedelta(minutes=75)


def enrich_coverage(resp, games_today):
    if games_today <= 0:
        return None
    if (resp.get('enriched') or 0) <= 0:
        return 'enriched 0 props on a game day'
    ts = resp.get('teamSources') or {}
    total = sum(ts.get(k, 0) for k in ('roster', 'logs', 'none'))
    if total and ts.get('none', 0) / total > MAX_UNRESOLVED_TEAM_SHARE:
        return f"team unresolved for {ts.get('none')}/{total} players"
    spreads = resp.get('espnSpreadsLoaded') or 0
    if spreads < MIN_SPREAD_SHARE * games_today:
        return f'spread loaded for {spreads}/{games_today} games'
    return None


def results_present(had_games, grades, results):
    if not had_games:
        return None
    if grades <= 0:
        return 'no prop grades for yesterday'
    if results <= 0:
        return 'no prop results for yesterday'
    return None


def _nba_regular_season(now):
    m, d = now.month, now.day
    return m in (11, 12, 1, 2, 3) or (m == 10 and d >= 20) or (m == 4 and d <= 20)


def defense_fresh(newest_fetched_at, now):
    if not newest_fetched_at:
        return 'no defense data'
    if not _nba_regular_season(now):
        return None
    ts = datetime.fromisoformat(newest_fetched_at.replace('Z', '+00:00'))
    if now - ts > DEFENSE_MAX_AGE:
        return f'defense data {(now - ts).total_seconds() / 3600:.0f}h old'
    return None


def in_pretip_window(first_tip, now, already_ok):
    if already_ok or first_tip is None:
        return False
    lead = first_tip - now
    return timedelta(0) < lead <= PRETIP_LEAD


def logs_ready(history_rows, log_rows):
    return history_rows == 0 or log_rows > 0


def wnba_offseason(now):
    return now.month not in (5, 6, 7, 8, 9, 10)
```

- [ ] **Step 4:** tests → 10 passed
- [ ] **Step 5:** commit `feat(pipeline): pure readiness/coverage checks`

---

### Task 2: Steps and phases

**Files:** Create `scripts/pipeline/steps.py`, `scripts/pipeline/phases.py`; Test `scripts/tests/test_pipeline_phases.py`

- [ ] **Step 1: failing tests**

```python
# scripts/tests/test_pipeline_phases.py
from pipeline.phases import PHASES

def names(phase):
    return [s.name for s in PHASES[phase]]

def test_overnight_order():
    assert names('overnight') == [
        'gamelogs', 'grade', 'grade_wnba', 'feed_grade', 'results', 'seasonstats', 'perf_snapshot',
        'props', 'props_wnba', 'wnba_stats', 'sim_3pm', 'enrich', 'streak', 'parlay',
        'defense_fresh']

def test_chains_and_dates():
    by = {s.name: s for s in PHASES['overnight']}
    assert {by[n].chain for n in ('gamelogs', 'grade', 'results', 'perf_snapshot')} == {'results'}
    assert by['gamelogs'].date_offset == -1 and by['props'].date_offset == 0
    assert by['grade'].readiness == 'logs_ready'
    assert by['results'].coverage == 'results_present'
    assert by['enrich'].coverage == 'enrich_coverage'

def test_critical_steps():
    crit = {s.name for p in PHASES.values() for s in p if s.critical}
    assert crit == {'gamelogs', 'grade', 'props', 'enrich'}

def test_other_phases():
    assert names('midday') == ['props', 'enrich', 'parlay_pass2']
    assert names('pretip') == ['lineups', 'props', 'enrich', 'snapshot']
    assert names('weekly') == ['player_bias', 'opponent_leaks']
```

- [ ] **Step 2:** run → FAIL
- [ ] **Step 3: implement**

```python
# scripts/pipeline/steps.py
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class Step:
    name: str
    chain: str
    kind: str                     # 'http' | 'python' | 'check'
    target: str = ''              # route path+query, script path (relative to scripts/), or check name
    date_offset: int = 0          # 0 = today (ET), -1 = yesterday
    critical: bool = False        # failure skips the rest of its chain
    readiness: Optional[str] = None
    coverage: Optional[str] = None
    skip_if: Optional[str] = None
```

```python
# scripts/pipeline/phases.py
from pipeline.steps import Step

R, S = 'results', 'slate'

PHASES = {
    'overnight': [
        Step('gamelogs', R, 'http', '/api/gamelogs?days=3', -1, critical=True),
        Step('grade', R, 'http', '/api/grade', -1, critical=True, readiness='logs_ready'),
        Step('grade_wnba', R, 'http', '/api/grade/wnba', -1, skip_if='wnba_offseason'),
        Step('feed_grade', R, 'http', '/api/feed/grade', -1),
        Step('results', R, 'http', '/api/results?force=true', -1, coverage='results_present'),
        Step('seasonstats', R, 'http', '/api/seasonstats', -1),
        Step('perf_snapshot', R, 'http', '/api/performance-snapshot', -1),
        Step('props', S, 'http', '/api/props?refresh=true', 0, critical=True),
        Step('props_wnba', S, 'http', '/api/props/wnba?refresh=true', 0, skip_if='wnba_offseason'),
        Step('wnba_stats', S, 'python', 'fetch_wnba_stats.py', 0, skip_if='wnba_offseason'),
        Step('sim_3pm', S, 'python', 'sim_3pm.py', 0),
        Step('enrich', S, 'http', '/api/enrich?force=true', 0, critical=True, coverage='enrich_coverage'),
        Step('streak', S, 'http', '/api/feed/generate/streak', 0),
        Step('parlay', S, 'http', '/api/feed/generate/parlay', 0),
        Step('defense_fresh', 'checks', 'check', 'defense_fresh', 0),
    ],
    'midday': [
        Step('props', S, 'http', '/api/props?refresh=true', 0, critical=True),
        Step('enrich', S, 'http', '/api/enrich?force=true', 0, critical=True, coverage='enrich_coverage'),
        Step('parlay_pass2', S, 'http', '/api/feed/generate/parlay?pass=2', 0),
    ],
    'pretip': [
        Step('lineups', S, 'http', '/api/lineups/fetch', 0),
        Step('props', S, 'http', '/api/props?refresh=true', 0, critical=True),
        Step('enrich', S, 'http', '/api/enrich?force=true', 0, critical=True, coverage='enrich_coverage'),
        Step('snapshot', S, 'http', '/api/props/snapshot', 0),
    ],
    'weekly': [
        Step('player_bias', 'weekly', 'http', '/api/player-bias?action=analyze', 0),
        Step('opponent_leaks', 'weekly', 'http', '/api/opponent-leaks?action=analyze', 0),
    ],
}
```

- [ ] **Step 4:** tests → 4 passed
- [ ] **Step 5:** commit `feat(pipeline): step definitions and phase order`

---

### Task 3: Store and HTTP client

**Files:** Create `scripts/pipeline/store.py`, `scripts/pipeline/http.py` (thin I/O; exercised via fakes in Task 4 and live in Task 8)

```python
# scripts/pipeline/store.py
"""Supabase REST for job_runs + the few counts the checks need. Logging must never
block the pipeline: write failures are printed and swallowed (callers mark the run
failed at the end via `self.write_errors`)."""
import os
from datetime import date, timedelta
from urllib.parse import quote
import requests

TABLE = 'job_runs'


class Store:
    def __init__(self, url=None, key=None):
        self.url = (url or os.environ['NEXT_PUBLIC_SUPABASE_URL']).rstrip('/') + '/rest/v1'
        key = key or os.environ['SUPABASE_SERVICE_KEY']
        self.h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
        self.write_errors = 0

    def _write(self, method, path, body):
        try:
            r = requests.request(method, f'{self.url}/{path}', headers={**self.h, 'Prefer': 'return=representation'},
                                 json=body, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001 — logging must not stop the pipeline
            print(f'[store] {method} {path} failed: {e}')
            self.write_errors += 1
            return None

    def start(self, run_id, phase, step, game_date, source='github'):
        rows = self._write('POST', TABLE, {'run_id': run_id, 'phase': phase, 'step': step,
                                           'game_date': game_date, 'source': source, 'status': 'running'})
        return rows[0]['id'] if rows else None

    def finish(self, row_id, **fields):
        if row_id:
            self._write('PATCH', f'{TABLE}?id=eq.{row_id}', fields)

    def count(self, table, query):
        r = requests.get(f'{self.url}/{table}?select=*&{query}', headers={**self.h, 'Prefer': 'count=exact', 'Range': '0-0'},
                         timeout=30)
        r.raise_for_status()
        return int(r.headers.get('Content-Range', '*/0').split('/')[-1])

    def _first(self, table, select, query):
        r = requests.get(f'{self.url}/{table}?select={select}&{query}&limit=1', headers=self.h, timeout=30)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    # --- lookups used by checks ---
    def history_rows(self, d):
        return self.count('prop_history', f'game_date=eq.{d}')

    def log_rows(self, d):
        return self.count('player_game_logs', f'game_date=eq.{d}')

    def grade_rows(self, d):
        return self.count('prop_grades', f'game_date=eq.{d}')

    def result_rows(self, d):
        return self.count('prop_results', f'date=eq.{d}')

    def _et_window(self, d):
        nxt = (date.fromisoformat(d) + timedelta(days=1)).isoformat()
        return f'commence_time=gte.{d}T04:00:00Z&commence_time=lt.{nxt}T12:00:00Z'

    def games_on(self, d):
        r = requests.get(f'{self.url}/props?select=game_id&{self._et_window(d)}', headers=self.h, timeout=30)
        r.raise_for_status()
        return len({x['game_id'] for x in r.json()})

    def first_tip(self, d):
        row = self._first('props', 'commence_time', f'{self._et_window(d)}&order=commence_time.asc')
        return row['commence_time'] if row else None

    def phase_ok_on(self, phase, d):
        return self.count(TABLE, f'phase=eq.{phase}&game_date=eq.{d}&step=eq.snapshot&status=eq.ok') > 0

    def newest_defense(self):
        row = self._first('team_defense_stats', 'fetched_at', 'order=fetched_at.desc')
        return row['fetched_at'] if row else None


class NullStore:
    """Dry-run store: prints instead of writing; lookups answer 'nothing yet'."""
    write_errors = 0

    def start(self, run_id, phase, step, game_date, source='github'):
        print(f'[dry-run] {phase}:{step} ({game_date})')
        return None

    def finish(self, row_id, **fields):
        pass

    def __getattr__(self, name):
        return lambda *a, **k: 0
```

```python
# scripts/pipeline/http.py
import os
import requests


class VercelClient:
    """GET a Prizm API route with the cron secret. Returns (status, json_or_None).
    Raises on connection errors/timeouts so the runner can retry."""

    def __init__(self, base=None, secret=None, timeout=300):
        self.base = (base or os.environ['VERCEL_APP_URL']).rstrip('/')
        self.h = {'Authorization': f"Bearer {secret or os.environ['CRON_SECRET']}"}
        self.timeout = timeout

    def get(self, path):
        r = requests.get(self.base + path, headers=self.h, timeout=self.timeout)
        try:
            body = r.json()
        except ValueError:
            body = {'text': r.text[:500]}
        return r.status_code, body
```

- [ ] **Step 1:** create both files exactly as above
- [ ] **Step 2:** `python3 -c "import pipeline.store, pipeline.http"` from `scripts/` → no output
- [ ] **Step 3:** commit `feat(pipeline): job_runs store and Vercel route client`

---

### Task 4: Runner

**Files:** Create `scripts/pipeline/runner.py`; Test `scripts/tests/test_pipeline_runner.py`

- [ ] **Step 1: failing tests**

```python
# scripts/tests/test_pipeline_runner.py
from datetime import datetime, timedelta, timezone
from pipeline.runner import run_phase

NOW = datetime(2026, 11, 3, 14, 0, tzinfo=timezone.utc)   # 09:00 ET Nov 3


class FakeStore:
    def __init__(self, **lookups):
        self.rows, self.lookups, self.write_errors = {}, lookups, 0
    def start(self, run_id, phase, step, game_date, source='github'):
        rid = len(self.rows) + 1
        self.rows[rid] = {'phase': phase, 'step': step, 'game_date': game_date, 'status': 'running'}
        return rid
    def finish(self, rid, **f):
        self.rows[rid].update(f)
    def __getattr__(self, name):
        v = self.__dict__['lookups'].get(name, 0)
        return (lambda *a, **k: v(*a) if callable(v) else v)
    def status(self, step):
        return [r['status'] for r in self.rows.values() if r['step'] == step]


class FakeHttp:
    def __init__(self, responses=None):
        self.calls, self.responses = [], responses or {}
    def get(self, path):
        self.calls.append(path)
        r = self.responses.get(path.split('?')[0], (200, {}))
        if callable(r):
            return r()
        if isinstance(r, Exception):
            raise r
        return r


def run(phase='overnight', http=None, store=None, **kw):
    return run_phase(phase, now=NOW, http=http or FakeHttp(), store=store or FakeStore(),
                     sleep=lambda s: None, python=lambda script: 0, **kw)


def test_overnight_runs_every_step_in_order():
    http, store = FakeHttp(), FakeStore(newest_defense=NOW.isoformat())
    assert run(http=http, store=store) == 0
    assert http.calls[0] == '/api/gamelogs?days=3'
    assert http.calls.index('/api/props?refresh=true') > http.calls.index('/api/performance-snapshot')
    assert store.status('grade_wnba') == ['skipped']        # November -> WNBA offseason
    assert store.status('defense_fresh') == ['ok']


def test_missing_defense_data_fails_run():
    store = FakeStore()
    assert run(store=store) == 1
    assert store.status('defense_fresh') == ['failed']


def test_dates_per_chain():
    store = FakeStore(newest_defense=NOW.isoformat())
    run(store=store)
    by = {r['step']: r['game_date'] for r in store.rows.values()}
    assert by['gamelogs'] == '2026-11-02' and by['props'] == '2026-11-03'


def test_critical_failure_skips_rest_of_chain_but_not_other_chain():
    http = FakeHttp({'/api/grade': (500, {'error': 'x'})})
    store = FakeStore(newest_defense=NOW.isoformat())
    assert run(http=http, store=store) == 1
    assert store.status('grade') == ['failed']
    assert store.status('results') == ['skipped']
    assert store.status('props') == ['ok']                   # slate chain still runs


def test_retries_5xx_then_succeeds_no_retry_on_4xx():
    seq = iter([(502, {}), (200, {})])
    http = FakeHttp({'/api/seasonstats': lambda: next(seq), '/api/feed/grade': (401, {})})
    store = FakeStore(newest_defense=NOW.isoformat())
    run(http=http, store=store)
    assert http.calls.count('/api/seasonstats') == 2
    assert http.calls.count('/api/feed/grade') == 1
    assert store.status('seasonstats') == ['ok'] and store.status('feed_grade') == ['failed']


def test_waits_for_logs_then_fails_after_three_refetches():
    store = FakeStore(history_rows=500, log_rows=0, newest_defense=NOW.isoformat())
    http = FakeHttp()
    assert run(http=http, store=store) == 1
    assert http.calls.count('/api/gamelogs?days=3') == 4       # initial + 3 re-fetches
    assert store.status('grade') == ['failed']


def test_enrich_coverage_failure_fails_run():
    http = FakeHttp({'/api/enrich': (200, {'enriched': 0})})
    store = FakeStore(games_on=8, newest_defense=NOW.isoformat())
    assert run(http=http, store=store) == 1
    assert store.status('enrich') == ['failed']
    assert store.status('streak') == ['skipped']              # enrich is critical


def test_pretip_gate_skips_outside_window():
    store, http = FakeStore(first_tip=(NOW + timedelta(hours=5)).isoformat()), FakeHttp()
    assert run('pretip', http=http, store=store) == 0
    assert http.calls == [] and store.status('gate') == ['skipped']


def test_pretip_runs_inside_window():
    store, http = FakeStore(first_tip=(NOW + timedelta(minutes=60)).isoformat(), games_on=0), FakeHttp()
    assert run('pretip', http=http, store=store) == 0
    assert http.calls[0] == '/api/lineups/fetch' and store.status('snapshot') == ['ok']


def test_dry_run_calls_nothing():
    http = FakeHttp()
    assert run(http=http, dry_run=True) == 0
    assert http.calls == []
```

- [ ] **Step 2:** run → FAIL
- [ ] **Step 3: implement**

```python
# scripts/pipeline/runner.py
"""Run one pipeline phase: steps in order, retries, chain/critical semantics,
readiness + coverage checks, one job_runs row per step. Returns 0 if every step
was ok or skipped, else 1 (GitHub then emails the user)."""
import json
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from pipeline import checks
from pipeline.phases import PHASES

ET = ZoneInfo('America/New_York')
RETRIES = 2
RETRY_WAIT_S = 30
LOG_REFETCHES = 3
LOG_REFETCH_WAIT_S = 600


def _iso(dt):
    return dt.isoformat()


def _summary(body):
    s = json.dumps(body, default=str)
    return json.loads(s) if len(s) <= 2000 else {'truncated': s[:2000]}


def _call(http, path, sleep):
    """GET with retries on 5xx / exceptions. Returns (status, body, error)."""
    last = None
    for attempt in range(RETRIES + 1):
        try:
            status, body = http.get(path)
            if status < 500:
                return status, body, None if status < 400 else f'HTTP {status}'
            last = f'HTTP {status}'
        except Exception as e:  # noqa: BLE001
            status, body, last = None, None, f'{type(e).__name__}: {e}'
        if attempt < RETRIES:
            sleep(RETRY_WAIT_S)
    return status, body, last


def run_phase(phase, *, now, http, store, sleep=time.sleep, python=None, dry_run=False, game_date=None, source='github'):
    today = game_date or now.astimezone(ET).date().isoformat()
    run_id = str(uuid.uuid4())
    if dry_run:
        for s in PHASES[phase]:
            print(f'[dry-run] {phase}:{s.name} -> {s.kind} {s.target}')
        return 0

    def day(offset):
        return (datetime.fromisoformat(today) + timedelta(days=offset)).date().isoformat()

    if phase == 'pretip':
        tip = store.first_tip(today)
        tip_dt = datetime.fromisoformat(tip.replace('Z', '+00:00')) if tip else None
        if not checks.in_pretip_window(tip_dt, now, already_ok=bool(store.phase_ok_on('pretip', today))):
            rid = store.start(run_id, phase, 'gate', today, source)
            store.finish(rid, status='skipped', finished_at=_iso(datetime.now(now.tzinfo)),
                         summary={'first_tip': tip})
            return 0

    failed_chains, any_failed = set(), False
    for step in PHASES[phase]:
        d = day(step.date_offset)
        rid = store.start(run_id, phase, step.name, d, source)
        t0 = time.monotonic()
        status, body, error, http_status = 'ok', None, None, None

        if step.chain in failed_chains:
            status = 'skipped'
            error = 'earlier critical step in chain failed'
        elif step.skip_if == 'wnba_offseason' and checks.wnba_offseason(now):
            status = 'skipped'
        else:
            if step.readiness == 'logs_ready':
                tries = 0
                while not checks.logs_ready(store.history_rows(d), store.log_rows(d)) and tries < LOG_REFETCHES:
                    sleep(LOG_REFETCH_WAIT_S)
                    http.get('/api/gamelogs?days=3')
                    tries += 1
                if not checks.logs_ready(store.history_rows(d), store.log_rows(d)):
                    status, error = 'failed', f'no game logs for {d} after {LOG_REFETCHES} re-fetches'
            if status == 'ok':
                if step.kind == 'http':
                    http_status, body, error = _call(http, step.target, sleep)
                    status = 'failed' if error else 'ok'
                elif step.kind == 'python':
                    code = python(step.target)
                    status, error = ('ok', None) if code == 0 else ('failed', f'exit {code}')
                elif step.kind == 'check' and step.target == 'defense_fresh':
                    error = checks.defense_fresh(store.newest_defense(), now)
                    status = 'failed' if error else 'ok'
            if status == 'ok' and step.coverage == 'enrich_coverage':
                error = checks.enrich_coverage(body or {}, store.games_on(d))
                status = 'failed' if error else 'ok'
            if status == 'ok' and step.coverage == 'results_present':
                error = checks.results_present(store.history_rows(d) > 0, store.grade_rows(d), store.result_rows(d))
                status = 'failed' if error else 'ok'

        if status == 'failed':
            any_failed = True
            if step.critical:
                failed_chains.add(step.chain)
        print(f'{phase}:{step.name} [{d}] {status}{" - " + error if error else ""}')
        store.finish(rid, status=status, finished_at=_iso(datetime.now(now.tzinfo)),
                     duration_ms=int((time.monotonic() - t0) * 1000), http_status=http_status,
                     summary=_summary(body) if body is not None else None, error=error)

    return 1 if any_failed or store.write_errors else 0
```

- [ ] **Step 4:** run → 10 passed. If `test_dates_per_chain` fails, check ET conversion of `NOW`.
- [ ] **Step 5:** commit `feat(pipeline): ordered phase runner with retries, chains and checks`

---

### Task 5: CLI, migration, workflows

- [ ] **Step 1: CLI**

```python
# scripts/pipeline/__main__.py
"""python -m pipeline <overnight|midday|pretip|weekly> [--date YYYY-MM-DD] [--dry-run]"""
import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone

from pipeline.http import VercelClient
from pipeline.phases import PHASES
from pipeline.runner import run_phase
from pipeline.store import NullStore, Store

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_python(script):
    return subprocess.run([sys.executable, os.path.join(SCRIPTS, script)], cwd=SCRIPTS, timeout=900).returncode


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('phase', choices=sorted(PHASES))
    ap.add_argument('--date')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    store = NullStore() if a.dry_run else Store()
    http = None if a.dry_run else VercelClient()
    return run_phase(a.phase, now=datetime.now(timezone.utc), http=http, store=store,
                     python=run_python, dry_run=a.dry_run, game_date=a.date)


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 2: migration** `supabase/migrations/20261025120000_job_runs.sql` — exactly the SQL block in the spec's "`job_runs` table" section.

- [ ] **Step 3: workflows** — four files, same body, different `name`, schedule and phase:

```yaml
# .github/workflows/pipeline-overnight.yml   (midday: '0 16 * * *' / pretip: '*/30 15-23,0-1 * * *' / weekly: '0 10 * * 0')
name: Pipeline - overnight
on:
  schedule:
    - cron: '0 9 * * *'
  workflow_dispatch:
    inputs:
      date: { description: 'ET game date (YYYY-MM-DD, optional)', required: false }
      dry_run: { description: 'Dry run', type: boolean, default: false }
concurrency: { group: pipeline-overnight, cancel-in-progress: false }
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      VERCEL_APP_URL: ${{ secrets.VERCEL_APP_URL }}
      CRON_SECRET: ${{ secrets.CRON_SECRET }}
      NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
      SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-python@v6
        with: { python-version: '3.12', cache: pip }
      - run: pip install -r requirements.txt scipy
      - name: Run phase
        working-directory: scripts
        run: python -m pipeline overnight ${{ inputs.date && format('--date {0}', inputs.date) || '' }} ${{ inputs.dry_run && '--dry-run' || '' }}
```

- [ ] **Step 4:** `cd scripts && python3 -m pipeline overnight --dry-run` → 15 `[dry-run] overnight:<step>` lines
- [ ] **Step 5:** commit `feat(pipeline): CLI, job_runs migration, scheduled workflows`

---

### Task 6: `/status` page

**Files:** Create `app/status/page.tsx`; Modify nav in `app/layout.tsx` (add `Status` link after Performance)

```tsx
// app/status/page.tsx
import { supabase } from '@/lib/supabase'

export const revalidate = 60

type Run = { run_id: string; phase: string; step: string; game_date: string | null; source: string
  status: 'running' | 'ok' | 'failed' | 'skipped'; started_at: string; duration_ms: number | null; error: string | null }

const COLORS: Record<Run['status'], string> = {
  ok: 'text-emerald-400', failed: 'text-red-400', skipped: 'text-white/40', running: 'text-[#FFB800]' }

async function newest(table: string, col: string): Promise<string | null> {
  const { data } = await supabase.from(table).select(col).order(col, { ascending: false }).limit(1)
  const row = (data?.[0] ?? null) as Record<string, string> | null
  return row ? row[col] : null
}

export default async function StatusPage() {
  const { data } = await supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(400)
  const runs = (data ?? []) as Run[]
  const latestRunByPhase = new Map<string, string>()
  for (const r of runs) if (!latestRunByPhase.has(r.phase)) latestRunByPhase.set(r.phase, r.run_id)
  const days = [...Array(7)].map((_, i) => new Date(Date.now() - i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
  const phases = ['overnight', 'midday', 'pretip', 'weekly', 'pc']
  const cell = (phase: string, day: string) => {
    const rs = runs.filter((r) => r.phase === phase && (r.started_at.slice(0, 10) === day || r.game_date === day) && r.step !== 'gate')
    if (rs.length === 0) return '·'
    return rs.some((r) => r.status === 'failed') ? '✗' : rs.some((r) => r.status === 'ok') ? '✓' : '–'
  }
  const fresh = await Promise.all([
    newest('player_game_logs', 'game_date'), newest('prop_grades', 'game_date'), newest('props', 'cached_at'),
    newest('team_defense_stats', 'fetched_at'), newest('kalshi_paper_trades', 'scanned_at')])
  const freshLabels = ['Newest game log', 'Newest grade', 'Props refreshed', 'Defense data', 'Kalshi scan']

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
      <h1 className="text-3xl font-bold">Pipeline status</h1>
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
        {freshLabels.map((l, i) => (
          <div key={l} className="rounded-lg border border-white/10 px-3 py-2">
            <div className="text-white/40">{l}</div><div className="font-mono">{fresh[i]?.slice(0, 16).replace('T', ' ') ?? '—'}</div>
          </div>))}
      </section>
      <section>
        <h2 className="text-sm uppercase tracking-wider text-white/40 mb-2">Last 7 days</h2>
        <table className="text-sm font-mono"><thead><tr><th className="text-left pr-4">phase</th>
          {days.map((d) => <th key={d} className="px-2 text-white/40">{d.slice(5)}</th>)}</tr></thead>
          <tbody>{phases.map((p) => <tr key={p}><td className="pr-4">{p}</td>
            {days.map((d) => <td key={d} className="px-2 text-center">{cell(p, d)}</td>)}</tr>)}</tbody></table>
      </section>
      {[...latestRunByPhase.entries()].map(([phase, runId]) => {
        const steps = runs.filter((r) => r.run_id === runId).reverse()
        return (
          <section key={phase}>
            <h2 className="text-sm uppercase tracking-wider text-white/40 mb-2">
              {phase} · {new Date(steps[0]?.started_at ?? '').toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</h2>
            <table className="w-full text-sm"><tbody>{steps.map((s) => (
              <tr key={s.step + s.started_at} className="border-t border-white/5">
                <td className="py-1 pr-3 font-mono">{s.step}</td><td className={`pr-3 ${COLORS[s.status]}`}>{s.status}</td>
                <td className="pr-3 text-white/40">{s.game_date}</td>
                <td className="pr-3 text-white/40">{s.duration_ms != null ? `${(s.duration_ms / 1000).toFixed(1)}s` : ''}</td>
                <td className="text-red-400/80 text-xs">{s.error ?? ''}</td></tr>))}</tbody></table>
          </section>)
      })}
    </main>
  )
}
```

- [ ] Steps: create page; add nav link; `npx tsc --noEmit -p .`; `npx next build`; commit `feat(status): pipeline status page`

---

### Task 7: PC jobs log to `job_runs`

**Files:** Modify `scripts/run_local_defense.py` (after each step: one row), `scripts/kalshi_edges/run_paper.py` (one row per subcommand)

```python
# in scripts/run_local_defense.py main(), wrap each step:
from pipeline.store import Store   # scripts/ is on sys.path (script lives in scripts/)
store = Store()                    # .env.local values are already in os.environ? -> load first (see below)
run_id = str(uuid.uuid4())
rid = store.start(run_id, 'pc', 'defense:' + label.replace(' ', '_'), datetime.now().date().isoformat(), source='pc')
# ... subprocess ...
store.finish(rid, status='ok' if r.returncode == 0 else 'failed', finished_at=datetime.now(timezone.utc).isoformat(),
             error=None if r.returncode == 0 else f'exit {r.returncode}')
```

`run_local_defense.py` must load `.env.local` into `os.environ` before `Store()` (same parser as `kalshi_edges/run_paper._load_env`). `run_paper.py`: in `main()`, after `_load_env()`, wrap the dispatched command with `Store().start(..., 'pc', f'kalshi:{cmd}', today, 'pc')` / `finish(...)` using the command's return code; any `Store` failure must not stop the command (Store already swallows write errors).

- [ ] Steps: implement; run `python3 scripts/run_local_defense.py` and `python -m kalshi_edges.run_paper report`; confirm two new `job_runs` rows with `source='pc'`; commit `feat(pipeline): PC jobs write job_runs`

---

### Task 8: Live rollout (checkpoints)

- [ ] User applies `supabase/migrations/20261025120000_job_runs.sql` in the SQL editor; verify `GET /rest/v1/job_runs?limit=1` → `[]`
- [ ] Push; CI green
- [ ] `gh workflow run pipeline-overnight.yml -f dry_run=true` → green, 15 dry-run lines
- [ ] `gh workflow run pipeline-midday.yml` (real) → green; `job_runs` has 3 `ok` rows; `/status` shows them
- [ ] `gh workflow run pipeline-overnight.yml` (real) → green or failures explained; review rows
- [ ] Leave existing Vercel crons + `daily-stats.yml` running alongside for one day
- [ ] **Next day:** remove all crons from `vercel.json` (`{"crons": []}`), delete `.github/workflows/daily-stats.yml`, commit `chore: retire Vercel crons and daily-stats in favor of the pipeline`
