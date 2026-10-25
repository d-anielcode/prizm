# WNBA Stats Pipeline (SP1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land WNBA game logs + team defense (ranks, L15, pace) in `wnba_player_game_logs` / `wnba_team_defense_stats`, with the NBA stats pipeline 100% unchanged and no WNBA scoring.

**Architecture:** A new, self-contained `scripts/fetch_wnba_stats.py` (separate from the NBA script) pulls WNBA data via `nba_api` (LeagueID `10`, season `'2026'`): league-wide `LeagueGameLog` for player logs (which carry `PLAYER_NAME` + `TEAM_ABBREVIATION` directly), and `LeagueDashTeamStats` (Opponent + Advanced) for defense ranks + pace — resolving the missing `TEAM_ABBREVIATION` on defense rows via a `TEAM_ID→abbr` map derived from the gamelog. Pure mapping helpers are unit-tested; the I/O lives under a `main()` guard. An additive `CREATE TABLE LIKE` migration creates the two `wnba_*` tables.

**Tech Stack:** Python 3.14 (`python3`), `nba_api` 1.11.4, pytest; Supabase PostgREST. Python tests run from `scripts/`. SP1b of the WNBA pivot.

**Spec:** `docs/superpowers/specs/2026-06-20-wnba-stats-pipeline-sp1b-design.md`

---

## File Structure

- Create (SQL, run via SQL editor): `supabase/migrations/20260620130000_wnba_stats_tables.sql`
- Create: `scripts/fetch_wnba_stats.py` — pure helpers (`gamelog_row_to_log`, `build_team_abbr_map`) + `main()`.
- Create: `scripts/tests/test_fetch_wnba_stats.py` — pytest for the pure helpers.
- Modify: `.github/workflows/daily-stats.yml` — WNBA stats step (continue-on-error, after NBA stats).

**Test command:** `cd scripts && python3 -m pytest tests/test_fetch_wnba_stats.py -v`. Use `python3` (not `py -3.13`). Commits end with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`. Do not push.

---

## Task 1: Additive migration — wnba_player_game_logs / wnba_team_defense_stats

**Files:**
- Create: `supabase/migrations/20260620130000_wnba_stats_tables.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260620130000_wnba_stats_tables.sql`:

```sql
-- WNBA stats pipeline (SP1b): mirrors of the NBA stat tables. Additive — no NBA
-- table is touched. LIKE does NOT copy GRANTs, so they are granted explicitly.
CREATE TABLE IF NOT EXISTS wnba_player_game_logs  (LIKE player_game_logs  INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_team_defense_stats (LIKE team_defense_stats INCLUDING ALL);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_player_game_logs, public.wnba_team_defense_stats TO service_role;
GRANT SELECT ON public.wnba_player_game_logs, public.wnba_team_defense_stats TO anon, authenticated;
```

- [ ] **Step 2: Apply it (Supabase SQL editor)**

DDL must run via the Supabase SQL editor (no linked CLI). Paste the file's contents into the SQL editor for the project and run, then **API → Reload schema**. (This is a user step, like SP1a.)

- [ ] **Step 3: Verify the tables are accessible**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}'}
for t in ['wnba_player_game_logs','wnba_team_defense_stats']:
    print(t, '->', requests.get(f'{U}/rest/v1/{t}?limit=0',headers=H,timeout=20).status_code)
"
```
Expected: each `-> 200`. (404/403 = migration not applied or schema not reloaded.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620130000_wnba_stats_tables.sql
git commit -m "feat(wnba): additive migration for wnba_player_game_logs/team_defense_stats"
```

---

## Task 2: Pure mapping helpers + tests

**Files:**
- Create: `scripts/fetch_wnba_stats.py` (helpers only this task)
- Create: `scripts/tests/test_fetch_wnba_stats.py`

- [ ] **Step 1: Write the failing tests**

Create `scripts/tests/test_fetch_wnba_stats.py`:

```python
from fetch_wnba_stats import gamelog_row_to_log, build_team_abbr_map

def test_gamelog_row_maps_and_computes_pra_home_win():
    row = {'PLAYER_NAME': "A'ja Wilson", 'PLAYER_ID': 1628886, 'TEAM_ID': 1611661321,
           'TEAM_ABBREVIATION': 'LVA', 'GAME_DATE': '2026-05-08', 'MATCHUP': 'LVA vs. SEA',
           'WL': 'W', 'MIN': 34, 'PTS': 30, 'REB': 10, 'AST': 5, 'FG3M': 2, 'BLK': 1, 'STL': 2}
    out = gamelog_row_to_log(row)
    assert out['player_name'] == "A'ja Wilson"
    assert out['game_date'] == '2026-05-08'
    assert out['points'] == 30 and out['rebounds'] == 10 and out['assists'] == 5
    assert out['fg3m'] == 2 and out['blocks'] == 1 and out['steals'] == 2
    assert out['pra'] == 45
    assert out['minutes'] == 34
    assert out['is_home'] is True
    assert out['win'] is True
    assert out['nba_id'] == 1628886

def test_gamelog_row_away_and_loss():
    row = {'PLAYER_NAME': 'X', 'PLAYER_ID': 1, 'GAME_DATE': '2026-05-09', 'MATCHUP': 'LVA @ SEA',
           'WL': 'L', 'MIN': 20, 'PTS': 5, 'REB': 2, 'AST': 1, 'FG3M': 0, 'BLK': 0, 'STL': 0}
    out = gamelog_row_to_log(row)
    assert out['is_home'] is False
    assert out['win'] is False
    assert out['pra'] == 8

def test_gamelog_row_handles_missing_numeric():
    row = {'PLAYER_NAME': 'Y', 'PLAYER_ID': 2, 'GAME_DATE': '2026-05-09', 'MATCHUP': 'A vs. B',
           'WL': 'W', 'PTS': None}
    out = gamelog_row_to_log(row)
    assert out['points'] == 0 and out['pra'] == 0

def test_build_team_abbr_map_dedups():
    rows = [{'TEAM_ID': 100, 'TEAM_ABBREVIATION': 'NYL'},
            {'TEAM_ID': 200, 'TEAM_ABBREVIATION': 'CON'},
            {'TEAM_ID': 100, 'TEAM_ABBREVIATION': 'NYL'}]
    assert build_team_abbr_map(rows) == {100: 'NYL', 200: 'CON'}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_fetch_wnba_stats.py -v`
Expected: FAIL — `No module named 'fetch_wnba_stats'`.

- [ ] **Step 3: Create `scripts/fetch_wnba_stats.py` with the pure helpers**

Create `scripts/fetch_wnba_stats.py`:

```python
"""
WNBA Stats Fetcher (SP1b)
=========================
Pulls WNBA game logs + team defensive rankings from stats.nba.com via nba_api
(LeagueID 10) and upserts into the wnba_* tables. Separate from fetch_nba_stats.py
so the NBA path is untouched. Run daily before WNBA enrichment (future SP3).

Usage:  python scripts/fetch_wnba_stats.py
"""
from datetime import datetime

# ── Pure helpers (no I/O — unit-tested) ──────────────────────────────────────
def _num(v):
    """Coerce an nba_api numeric (often np.int64) or None to a plain number."""
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0

def gamelog_row_to_log(row):
    """Map one LeagueGameLog record -> a wnba_player_game_logs row."""
    pts, reb, ast = _num(row.get('PTS')), _num(row.get('REB')), _num(row.get('AST'))
    matchup = row.get('MATCHUP') or ''
    pid = row.get('PLAYER_ID')
    return {
        'player_name': row.get('PLAYER_NAME'),
        'nba_id':      int(pid) if pid is not None else None,
        'game_date':   str(row.get('GAME_DATE'))[:10],   # LeagueGameLog GAME_DATE is ISO YYYY-MM-DD
        'matchup':     matchup,
        'is_home':     'vs.' in matchup,                 # "LVA vs. SEA" = home; "LVA @ SEA" = away
        'minutes':     _num(row.get('MIN')),
        'points':      pts,
        'rebounds':    reb,
        'assists':     ast,
        'fg3m':        _num(row.get('FG3M')),
        'blocks':      _num(row.get('BLK')),
        'steals':      _num(row.get('STL')),
        'pra':         pts + reb + ast,
        'win':         row.get('WL') == 'W',
    }

def build_team_abbr_map(rows):
    """TEAM_ID -> TEAM_ABBREVIATION from gamelog records (defense rows lack abbr)."""
    out = {}
    for r in rows:
        tid, ab = r.get('TEAM_ID'), r.get('TEAM_ABBREVIATION')
        if tid is not None and ab:
            out[int(tid)] = ab
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_fetch_wnba_stats.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch_wnba_stats.py scripts/tests/test_fetch_wnba_stats.py
git commit -m "feat(wnba): pure gamelog/abbr mapping helpers for WNBA stats fetch"
```

---

## Task 3: The fetch `main()` + live smoke

**Files:**
- Modify: `scripts/fetch_wnba_stats.py` (append I/O + `main()`)

- [ ] **Step 1: Append `main()` to `scripts/fetch_wnba_stats.py`**

Append this AFTER the pure helpers:

```python
# ── I/O + entrypoint (kept out of import path so tests need no env/network) ──
def main():
    import os, sys, time
    import requests

    # Credentials (env vars take priority, fall back to .env.local)
    env = {}
    ENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env.local')
    try:
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    SUPABASE_URL = (os.environ.get('NEXT_PUBLIC_SUPABASE_URL') or env.get('NEXT_PUBLIC_SUPABASE_URL', '')).strip('"').strip("'")
    SUPABASE_KEY = (os.environ.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_SERVICE_KEY', '')).strip('"').strip("'")
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY"); sys.exit(1)
    HEADERS = {
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
    }

    def upsert(table, rows, on_conflict):
        if not rows:
            return
        url = f'{SUPABASE_URL}/rest/v1/{table}?on_conflict={on_conflict}'
        for i in range(0, len(rows), 200):
            r = requests.post(url, headers=HEADERS, json=rows[i:i+200], timeout=30)
            if not r.ok:
                print(f'  [supabase] upsert error on {table}: {r.status_code} {r.text[:200]}')

    # nba_api (imported here so module import stays light for tests)
    from nba_api.stats.endpoints import leaguegamelog, leaguedashteamstats
    try:
        from nba_api.stats.library.http import STATS_HEADERS
    except ImportError:
        from nba_api.library.http import STATS_HEADERS
    STATS_HEADERS.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.wnba.com/', 'Origin': 'https://www.wnba.com',
        'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
    })

    SEASON = '2026'
    LEAGUE = '10'

    # 1. Player game logs (league-wide; carries names + abbrs)
    print('[1/2] WNBA game logs...')
    gl_df = leaguegamelog.LeagueGameLog(
        league_id=LEAGUE, season=SEASON, season_type_all_star='Regular Season',
        player_or_team_abbreviation='P', timeout=30).get_data_frames()[0]
    gl_rows = gl_df.to_dict('records')
    log_rows = [gamelog_row_to_log(r) for r in gl_rows]
    upsert('wnba_player_game_logs', log_rows, 'player_name,game_date')
    print(f'      {len(log_rows)} game-log rows')
    abbr = build_team_abbr_map(gl_rows)

    # 2. Team defense (ranks + L15 + pace)
    print('[2/2] WNBA team defense...')
    RANK_COL_MAP = {
        'pts_rank': 'OPP_PTS_RANK', 'reb_rank': 'OPP_REB_RANK', 'ast_rank': 'OPP_AST_RANK',
        'blk_rank': 'OPP_BLK_RANK', 'stl_rank': 'OPP_STL_RANK', 'fg3m_rank': 'OPP_FG3M_RANK',
    }

    def opp(last_n=0):
        kw = dict(league_id_nullable=LEAGUE, season=SEASON, season_type_all_star='Regular Season',
                  measure_type_detailed_defense='Opponent', per_mode_detailed='PerGame', timeout=20)
        if last_n > 0:
            kw['last_n_games'] = last_n
        try:
            return leaguedashteamstats.LeagueDashTeamStats(**kw).get_data_frames()[0]
        except TypeError:
            kw.pop('per_mode_detailed', None)
            return leaguedashteamstats.LeagueDashTeamStats(**kw).get_data_frames()[0]

    def abbr_of(row):
        tid = row.get('TEAM_ID')
        return abbr.get(int(tid)) if tid is not None else None

    df_season = opp(0)
    team_rows = []
    for _, row in df_season.iterrows():
        ab = abbr_of(row)
        if not ab:
            continue
        e = {'team_abbreviation': ab, 'fetched_at': datetime.utcnow().isoformat()}
        for rc, nc in RANK_COL_MAP.items():
            v = row.get(nc)
            e[rc] = int(v) if v is not None else 15
        team_rows.append(e)

    time.sleep(1)
    df_l15 = opp(15)
    l15 = {}
    for _, row in df_l15.iterrows():
        ab = abbr_of(row)
        if not ab:
            continue
        l15[ab] = {f'{rc}_l15': (int(row[nc]) if row.get(nc) is not None else 15)
                   for rc, nc in RANK_COL_MAP.items()}
    for e in team_rows:
        x = l15.get(e['team_abbreviation'], {})
        for rc in RANK_COL_MAP:
            e[f'{rc}_l15'] = x.get(f'{rc}_l15', e.get(rc, 15))

    time.sleep(1)
    try:
        adv = leaguedashteamstats.LeagueDashTeamStats(
            league_id_nullable=LEAGUE, season=SEASON, season_type_all_star='Regular Season',
            measure_type_detailed_defense='Advanced', per_mode_detailed='PerGame', timeout=20
        ).get_data_frames()[0]
        pace = {}
        for _, r in adv.iterrows():
            ab = abbr_of(r)
            if ab:
                pace[ab] = float(r.get('PACE', 0) or 0)
        for e in team_rows:
            e['pace'] = pace.get(e['team_abbreviation'])
    except Exception as ex:
        print(f'      WARN: pace fetch failed: {ex}')

    upsert('wnba_team_defense_stats', team_rows, 'team_abbreviation')
    print(f'      {len(team_rows)} team defense rows')


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Confirm the helper tests still pass (import path unchanged)**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/test_fetch_wnba_stats.py -q`
Expected: 4 passed (importing the module must NOT run `main()` or need env).

- [ ] **Step 3: Live smoke run (dev reaches stats.nba.com)**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 scripts/fetch_wnba_stats.py
```
Expected: prints `[1/2] … ~2300+ game-log rows` and `[2/2] … ~15 team defense rows` with no Supabase upsert errors.

- [ ] **Step 4: Verify the data landed (and pace populated)**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}'}
def cnt(t):
    return requests.get(f'{U}/rest/v1/{t}?select=id',headers={**H,'Prefer':'count=exact','Range':'0-0'},timeout=20).headers.get('content-range')
print('wnba_player_game_logs:', cnt('wnba_player_game_logs'))
td=requests.get(f'{U}/rest/v1/wnba_team_defense_stats?select=team_abbreviation,pts_rank,pace&limit=4',headers=H,timeout=20).json()
print('team defense sample:', td)
"
```
Expected: game-log count in the thousands; team defense rows with real abbreviations (e.g. NYL), ranks, and non-null `pace`.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch_wnba_stats.py
git commit -m "feat(wnba): fetch WNBA game logs + team defense into wnba_* tables"
```

---

## Task 4: Add WNBA stats to the daily workflow

**Files:**
- Modify: `.github/workflows/daily-stats.yml`

- [ ] **Step 1: Add a WNBA stats step after the NBA defense fetch**

In `.github/workflows/daily-stats.yml`, find the NBA step `- name: Fetch NBA team defense + DVP (ranks, L15, pace)` (it runs `python3 scripts/fetch_nba_stats.py --defense-only`). Immediately AFTER that step's block, insert:

```yaml
      - name: Fetch WNBA stats (game logs + team defense)
        continue-on-error: true   # WNBA is isolated — must never disturb the NBA pipeline
        env:
          NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.NEXT_PUBLIC_SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: |
          echo "Fetching WNBA game logs + team defense..."
          python3 scripts/fetch_wnba_stats.py
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `cd /c/Users/dcho0/nbaiqproject && python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/daily-stats.yml')); names=[s.get('name') for s in d['jobs']['refresh']['steps']]; assert 'Fetch WNBA stats (game logs + team defense)' in names, names; print('WNBA stats step present; YAML valid')"`
Expected: `WNBA stats step present; YAML valid`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/daily-stats.yml
git commit -m "feat(wnba): fetch WNBA stats in the daily workflow (isolated)"
```

---

## Task 5: Full verification + NBA non-regression

**Files:** none (verification).

- [ ] **Step 1: Full Python suite**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/ -q 2>&1 | tail -4`
Expected: all pass (existing + `test_fetch_wnba_stats.py`).

- [ ] **Step 2: Confirm NBA stats tables were not touched by the WNBA run**

Run (compare NBA counts to before the Task 3 smoke — they must be unchanged):
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}','Prefer':'count=exact','Range':'0-0'}
for t in ['player_game_logs','team_defense_stats']:
    print(t, requests.get(f'{U}/rest/v1/{t}?select=id',headers=H,timeout=20).headers.get('content-range'))
"
```
Expected: NBA counts consistent with their pre-WNBA-run values (the WNBA script writes only `wnba_*`).

- [ ] **Step 3: Confirm compile + py_compile of the script**

Run: `cd /c/Users/dcho0/nbaiqproject && python3 -m py_compile scripts/fetch_wnba_stats.py && echo "COMPILE OK"`
Expected: `COMPILE OK`.

- [ ] **Step 4: Final commit (only if a fixup was needed)**

Otherwise no commit.

---

## Self-Review notes

- **Spec coverage:** additive `wnba_player_game_logs`/`wnba_team_defense_stats` migration + grants (Task 1); pure mapping helpers `gamelog_row_to_log`/`build_team_abbr_map` with tests (Task 2); `main()` fetching game logs (`LeagueGameLog` league 10, season 2026) + team defense (Opponent ranks + L15 + Advanced pace) with the gamelog-derived `TEAM_ID→abbr` map, into `wnba_*` (Task 3); isolated `continue-on-error` workflow step (Task 4); live smoke + NBA non-regression (Tasks 3,5). DVP/positions, scoring, UI are out of scope per the spec — no task touches them.
- **No NBA file/table changed** — separate script + separate tables.
- **Type consistency:** `gamelog_row_to_log(row)→dict`, `build_team_abbr_map(rows)→{int:str}` defined in Task 2 and used in Task 3's `main()`; `RANK_COL_MAP` mirrors `fetch_nba_stats.py`; upsert conflict targets (`player_name,game_date`; `team_abbreviation`) match the mirrored tables' unique keys.
