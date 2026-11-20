import subprocess
from pipeline import __main__ as pm


def test_run_python_timeout_fails_step_not_phase(monkeypatch):
    def boom(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="x", timeout=1)
    monkeypatch.setattr(pm.subprocess, "run", boom)
    assert pm.run_python("kalshi_settle.py") == pm.TIMEOUT_EXIT
