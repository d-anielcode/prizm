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
