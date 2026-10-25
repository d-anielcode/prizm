r"""Daily NBA defense + positions refresh, run from a home PC.

stats.nba.com times out from GitHub Actions runners (cloud IPs), so the
daily-stats workflow can't refresh team_defense_stats. Windows Task Scheduler
runs this every morning, before the workflow's freshness check:

    task "Prizm NBA defense refresh": <pythonw.exe> scripts\run_local_defense.py

pythonw.exe has no console, so no window pops up; the child scripts reuse it with
CREATE_NO_WINDOW and all output goes to the log.

Log: .logs\defense-refresh.log in the repo (gitignored). Not under AppData: this
Python is a packaged install and its AppData writes were not visible outside it.
"""
import os, subprocess, sys, uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.env import load_env_local  # noqa: E402
from pipeline.store import safe_store  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR = os.path.join(REPO, '.logs')
STEPS = [
    ('team defense + DVP', ['fetch_nba_stats.py', '--defense-only']),
    ('player positions', ['fetch_player_positions.py']),
    ('freshness check', ['check_data_freshness.py']),
]


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    load_env_local()
    store, run_id = safe_store(), str(uuid.uuid4())  # job_runs logging; optional
    worst = 0
    with open(os.path.join(LOG_DIR, 'defense-refresh.log'), 'a', encoding='utf-8') as log:
        log.write(f'[{datetime.now():%Y-%m-%dT%H:%M:%S}] start ({sys.executable})\n')
        for label, (script, *args) in STEPS:
            log.write(f'[{datetime.now():%Y-%m-%dT%H:%M:%S}] {label}\n'); log.flush()
            rid = store.start(run_id, 'pc', 'defense:' + label.replace(' ', '_'),
                              datetime.now().date().isoformat(), source='pc') if store else None
            r = subprocess.run([sys.executable, os.path.join(REPO, 'scripts', script), *args],
                               cwd=REPO, stdout=log, stderr=subprocess.STDOUT,
                               env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
                               creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            log.write(f'[{datetime.now():%Y-%m-%dT%H:%M:%S}] {label} exit={r.returncode}\n'); log.flush()
            if store:
                store.finish(rid, status='ok' if r.returncode == 0 else 'failed',
                             finished_at=datetime.now(timezone.utc).isoformat(),
                             error=None if r.returncode == 0 else f'exit {r.returncode}')
            worst = max(worst, r.returncode)
    return worst


if __name__ == '__main__':
    sys.exit(main())
