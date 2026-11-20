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


def safe_store():
    """Store for jobs where logging is optional (PC tasks): None if env is missing."""
    try:
        return Store()
    except Exception as e:  # noqa: BLE001
        print(f'[store] job_runs logging disabled: {e}')
        return None
