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
