# WNBA Grading Pipeline (SP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start accumulating graded WNBA props — snapshot unscored WNBA props to history, grade them against game-log outcomes into `wnba_prop_grades`, and deploy SP1a so live capture→snapshot→grade runs daily. NBA path unchanged; no model scoring.

**Architecture:** Add a `snapshotUnscored` flag to the league props config so WNBA props (which have no confidence score) still get snapshotted to `wnba_prop_history`. Extract the `/api/grade` logic into a league-parameterized `lib/grade.ts` (`gradeProp` pure + `gradeLeague(req, cfg)`); NBA `/api/grade` delegates with its config (identical behavior) and a new `/api/grade/wnba` grades `wnba_prop_history` + `wnba_player_game_logs` → `wnba_prop_grades` (no label filter). An additive migration creates `wnba_prop_grades`. A `continue-on-error` workflow step + the SP1a deploy turn accumulation on.

**Tech Stack:** Next 16 / TypeScript, vitest; Supabase PostgREST. TS tests via `npx vitest run`. SP2 of the WNBA pivot.

**Spec:** `docs/superpowers/specs/2026-06-20-wnba-grading-pipeline-sp2-design.md`

---

## File Structure

- Create (SQL, run via SQL editor): `supabase/migrations/20260620140000_wnba_prop_grades.sql`
- Modify: `lib/props-refresh.ts` — `snapshotUnscored?` flag on `LeaguePropConfig`; conditional snapshot filter; wnba config sets it `true`.
- Create: `lib/grade.ts` — `gradeProp` (pure), `gradeLeague(req, cfg)`, `GRADE_CONFIGS`.
- Modify: `app/api/grade/route.ts` — thin wrapper → `gradeLeague(req, GRADE_CONFIGS.nba)`.
- Create: `app/api/grade/wnba/route.ts` — `gradeLeague(req, GRADE_CONFIGS.wnba)`.
- Modify: `.github/workflows/daily-stats.yml` — WNBA grade step.
- Modify: `lib/__tests__/props-refresh.test.ts`; Create: `lib/__tests__/grade.test.ts`.

**Test command:** `cd /c/Users/dcho0/nbaiqproject && npx vitest run`. Commits end with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`. Do not push (except the deploy task, with explicit user go).

---

## Task 1: Additive migration — wnba_prop_grades

**Files:**
- Create: `supabase/migrations/20260620140000_wnba_prop_grades.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260620140000_wnba_prop_grades.sql`:

```sql
-- WNBA grading (SP2): mirror of prop_grades. Additive — no NBA table touched.
-- LIKE doesn't copy GRANTs, so grant explicitly.
CREATE TABLE IF NOT EXISTS wnba_prop_grades (LIKE prop_grades INCLUDING ALL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_prop_grades TO service_role;
GRANT SELECT ON public.wnba_prop_grades TO anon, authenticated;
```

- [ ] **Step 2: Apply via the Supabase SQL editor**

Paste the file's contents into the SQL editor for the project and run, then **API → Reload schema**. (User step, like SP1a/SP1b.)

- [ ] **Step 3: Verify accessible**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']
print('wnba_prop_grades ->', requests.get(f'{U}/rest/v1/wnba_prop_grades?limit=0',headers={'apikey':K,'Authorization':f'Bearer {K}'},timeout=20).status_code)
"
```
Expected: `-> 200`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620140000_wnba_prop_grades.sql
git commit -m "feat(wnba): additive migration for wnba_prop_grades"
```

---

## Task 2: snapshotUnscored flag so WNBA props get snapshotted

**Files:**
- Modify: `lib/props-refresh.ts`
- Modify: `lib/__tests__/props-refresh.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `lib/__tests__/props-refresh.test.ts`:

```typescript
describe('snapshotUnscored', () => {
  it('WNBA snapshots unscored props; NBA does not', () => {
    expect(LEAGUE_PROP_CONFIGS.wnba.snapshotUnscored).toBe(true)
    expect(LEAGUE_PROP_CONFIGS.nba.snapshotUnscored ?? false).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/props-refresh.test.ts`
Expected: FAIL — `snapshotUnscored` undefined on wnba config.

- [ ] **Step 3: Implement**

In `lib/props-refresh.ts`, add `snapshotUnscored` to the interface (after `historyTable: string`):

```typescript
  /** WNBA props are unscored; snapshot them to history anyway so they can be graded. */
  snapshotUnscored?: boolean
```

Set it on the WNBA config — change the `wnba:` line in `LEAGUE_PROP_CONFIGS` to:

```typescript
  wnba: { league: 'wnba', fetchEvents: fetchTodaysWNBAEvents, propsTable: 'wnba_props', altsTable: 'wnba_prop_alts', historyTable: 'wnba_prop_history', snapshotUnscored: true },
```

Then make the snapshot query honor it. Replace the snapshot read (currently):
```typescript
    const existing = await safeQuery(
      supabase.from(cfg.propsTable).select('*').not('confidence_label', 'is', null),
      'snapshot existing enriched props'
    )
```
with:
```typescript
    // NBA snapshots only enriched props; WNBA props are unscored, so snapshot all
    // of them (snapshotUnscored) — grading is score-independent and needs history.
    const snapQuery = cfg.snapshotUnscored
      ? supabase.from(cfg.propsTable).select('*')
      : supabase.from(cfg.propsTable).select('*').not('confidence_label', 'is', null)
    const existing = await safeQuery(snapQuery, 'snapshot existing props')
```

- [ ] **Step 4: Run to verify pass + full suite**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/props-refresh.test.ts && npx vitest run`
Expected: props-refresh test passes; full suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/props-refresh.ts lib/__tests__/props-refresh.test.ts
git commit -m "feat(wnba): snapshot unscored WNBA props to history for grading"
```

---

## Task 3: Extract league-parameterized grade helper (lib/grade.ts)

**Files:**
- Create: `lib/grade.ts`
- Create: `lib/__tests__/grade.test.ts`
- Modify: `app/api/grade/route.ts`

- [ ] **Step 1: Write the failing test for `gradeProp`**

Create `lib/__tests__/grade.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { gradeProp, GRADE_CONFIGS } from '../grade'

const hist = (over: boolean, line: number, stat = 'points') =>
  ({ player_name: 'X', stat_type: stat, line, direction: over ? 'over' : 'under' })
const log = (over: Record<string, unknown>) => ({ minutes: 30, ...over })

describe('gradeProp', () => {
  it('over hits when actual exceeds line', () => {
    expect(gradeProp(hist(true, 24.5), log({ points: 30 }))).toEqual({ actual_value: 30, hit: true })
  })
  it('over misses when actual below line', () => {
    expect(gradeProp(hist(true, 24.5), log({ points: 20 }))).toEqual({ actual_value: 20, hit: false })
  })
  it('under hits when actual below line', () => {
    expect(gradeProp(hist(false, 24.5), log({ points: 20 }))).toEqual({ actual_value: 20, hit: true })
  })
  it('DNP (no log) -> null hit', () => {
    expect(gradeProp(hist(true, 24.5), undefined)).toEqual({ actual_value: null, hit: null })
  })
  it('DNP (under 5 minutes) -> null hit', () => {
    expect(gradeProp(hist(true, 24.5), { minutes: 3, points: 40 })).toEqual({ actual_value: null, hit: null })
  })
  it('played but stat is null -> skip (returns null)', () => {
    expect(gradeProp(hist(true, 24.5), { minutes: 30, points: null })).toBeNull()
  })
})

describe('GRADE_CONFIGS', () => {
  it('NBA targets NBA tables and requires a label', () => {
    const c = GRADE_CONFIGS.nba
    expect([c.historyTable, c.logsTable, c.gradesTable, c.requireLabel]).toEqual(['prop_history', 'player_game_logs', 'prop_grades', true])
  })
  it('WNBA targets wnba_* tables and does NOT require a label', () => {
    const c = GRADE_CONFIGS.wnba
    expect([c.historyTable, c.logsTable, c.gradesTable, c.requireLabel]).toEqual(['wnba_prop_history', 'wnba_player_game_logs', 'wnba_prop_grades', false])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/grade.test.ts`
Expected: FAIL — `No module … grade`.

- [ ] **Step 3: Create `lib/grade.ts`**

Create `lib/grade.ts` (the `/api/grade` POST logic, parameterized; `getStatValue` + `getServiceClient` moved here):

```typescript
// League-parameterized prop grading. /api/grade (NBA) and /api/grade/wnba both
// call gradeLeague with their config — one implementation.
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { StatType } from '@/types'
import { requireCronAuth } from '@/lib/api-auth'

export interface GradeConfig {
  league: 'nba' | 'wnba'
  historyTable: string
  logsTable: string
  gradesTable: string
  requireLabel: boolean        // NBA grades only enriched props; WNBA grades all
  refreshPerfSnapshot?: boolean // NBA pre-warms the performance page after grading
}

export const GRADE_CONFIGS: Record<'nba' | 'wnba', GradeConfig> = {
  nba:  { league: 'nba',  historyTable: 'prop_history',      logsTable: 'player_game_logs',      gradesTable: 'prop_grades',      requireLabel: true,  refreshPerfSnapshot: true },
  wnba: { league: 'wnba', historyTable: 'wnba_prop_history', logsTable: 'wnba_player_game_logs', gradesTable: 'wnba_prop_grades', requireLabel: false },
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

function getStatValue(row: Record<string, unknown>, statType: StatType): number | null {
  switch (statType) {
    case 'points':         return row.points   != null ? Number(row.points)   : null
    case 'rebounds':       return row.rebounds != null ? Number(row.rebounds) : null
    case 'assists':        return row.assists  != null ? Number(row.assists)  : null
    case 'steals':         return row.steals   != null ? Number(row.steals)   : null
    case 'blocks':         return row.blocks   != null ? Number(row.blocks)   : null
    case 'three_pointers': return row.fg3m     != null ? Number(row.fg3m)     : null
    case 'pra':            return row.pra      != null ? Number(row.pra)      : null
    default:               return null
  }
}

/**
 * Pure grade of one prop against its game log.
 *  - no log OR minutes < 5  -> DNP: { actual_value: null, hit: null }
 *  - played but stat is null -> null (caller skips, no grade row)
 *  - otherwise -> { actual_value, hit }
 */
export function gradeProp(
  hist: Record<string, unknown>,
  log: Record<string, unknown> | undefined,
): { actual_value: number | null; hit: boolean | null } | null {
  const minutes = log ? Number(log.minutes ?? 0) : 0
  if (!log || minutes < 5) return { actual_value: null, hit: null }
  const actual = getStatValue(log, hist.stat_type as StatType)
  if (actual == null) return null
  const hit = hist.direction === 'over' ? actual > Number(hist.line) : actual < Number(hist.line)
  return { actual_value: actual, hit }
}

export async function gradeLeague(req: Request, cfg: GradeConfig) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const db = getServiceClient()
    const { searchParams } = new URL(req.url)
    const dateParam = searchParams.get('date')
    const gradeDate = dateParam ?? (() => {
      const d = new Date(Date.now() - 86400000)
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    })()

    console.log(`[/api/grade ${cfg.league}] Grading props for ${gradeDate}`)

    let histSel = db.from(cfg.historyTable)
      .select('player_name, stat_type, line, direction, confidence_label, confidence_score, game_date')
      .eq('game_date', gradeDate)
    if (cfg.requireLabel) histSel = histSel.not('confidence_label', 'is', null)
    const { data: histRows, error: histErr } = await histSel
    if (histErr) throw new Error(`${cfg.historyTable} read: ${histErr.message}`)
    if (!histRows || histRows.length === 0) {
      return NextResponse.json({ message: `No ${cfg.historyTable} rows for ${gradeDate}`, graded: 0 })
    }

    const playerNames = [...new Set(histRows.map((r) => r.player_name as string))]
    const { data: logRows, error: logErr } = await db
      .from(cfg.logsTable)
      .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
      .in('player_name', playerNames)
      .eq('game_date', gradeDate)
    if (logErr) throw new Error(`${cfg.logsTable} read: ${logErr.message}`)

    const logByPlayer = new Map<string, Record<string, unknown>>()
    for (const row of logRows ?? []) logByPlayer.set(row.player_name as string, row as Record<string, unknown>)

    const grades: Record<string, unknown>[] = []
    let matched = 0, dnp = 0
    for (const hist of histRows) {
      const g = gradeProp(hist as Record<string, unknown>, logByPlayer.get(hist.player_name as string))
      if (g === null) continue
      grades.push({
        game_date: hist.game_date, player_name: hist.player_name, stat_type: hist.stat_type,
        line: hist.line, direction: hist.direction,
        confidence_label: hist.confidence_label, confidence_score: hist.confidence_score,
        actual_value: g.actual_value, hit: g.hit,
      })
      if (g.hit === null) dnp++; else matched++
    }

    const dedupMap = new Map<string, Record<string, unknown>>()
    for (const g of grades) {
      const key = `${g.game_date}|${g.player_name}|${g.stat_type}|${g.line}|${g.direction}`
      if (!dedupMap.has(key)) dedupMap.set(key, g)
    }
    const deduped = [...dedupMap.values()]

    const BATCH = 500
    let upserted = 0
    for (let i = 0; i < deduped.length; i += BATCH) {
      const { error } = await db.from(cfg.gradesTable)
        .upsert(deduped.slice(i, i + BATCH), { onConflict: 'game_date,player_name,stat_type,line,direction' })
      if (error) console.error(`[/api/grade ${cfg.league}] upsert error:`, error.message)
      else upserted += deduped.slice(i, i + BATCH).length
    }

    console.log(`[/api/grade ${cfg.league}] Done — ${matched} graded, ${dnp} DNP, ${upserted} upserted`)

    // NBA only: fire-and-forget refresh of the performance-page snapshot cache
    // (preserves the original /api/grade behavior; WNBA has no such page yet).
    if (cfg.refreshPerfSnapshot) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
      fetch(`${baseUrl}/api/performance-snapshot`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
      }).catch(() => {})
    }

    return NextResponse.json({ gradeDate, league: cfg.league, graded: matched, dnp, upserted })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[/api/grade ${cfg.league}] Error:`, message)
    return NextResponse.json({ error: 'Grading failed', details: message }, { status: 500 })
  }
}
```

(Note: the NBA route's fire-and-forget `performance-snapshot` refresh is preserved exactly — gated to NBA via `refreshPerfSnapshot` in the config, so NBA behavior is unchanged and WNBA skips it.)

- [ ] **Step 4: Replace `app/api/grade/route.ts` with a thin NBA wrapper**

Overwrite `app/api/grade/route.ts` with:

```typescript
// /api/grade — grades NBA props (prop_history + player_game_logs -> prop_grades).
// League-agnostic implementation lives in lib/grade.ts; this binds it to NBA.
import { gradeLeague, GRADE_CONFIGS } from '@/lib/grade'

export const maxDuration = 120

export async function POST(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.nba)
}
export async function GET(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.nba)
}
```

- [ ] **Step 5: Run grade test + full suite + typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/grade.test.ts && npx vitest run && npx tsc --noEmit 2>&1 | tail -5 && echo TSC_DONE`
Expected: grade tests pass (8); full suite green; no tsc errors before `TSC_DONE`.

- [ ] **Step 6: Commit**

```bash
git add lib/grade.ts lib/__tests__/grade.test.ts app/api/grade/route.ts
git commit -m "refactor(grade): extract league-parameterized grade helper (gradeProp/gradeLeague)"
```

---

## Task 4: Add the /api/grade/wnba route

**Files:**
- Create: `app/api/grade/wnba/route.ts`

- [ ] **Step 1: Create the WNBA grade route**

Create `app/api/grade/wnba/route.ts`:

```typescript
// /api/grade/wnba — grades WNBA props (wnba_prop_history + wnba_player_game_logs
// -> wnba_prop_grades). Same implementation as /api/grade, bound to WNBA (no
// confidence-label requirement — WNBA props are unscored).
import { gradeLeague, GRADE_CONFIGS } from '@/lib/grade'

export const maxDuration = 120

export async function POST(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.wnba)
}
export async function GET(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.wnba)
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit 2>&1 | grep -E "grade/wnba|lib/grade" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 3: Commit**

```bash
git add "app/api/grade/wnba/route.ts"
git commit -m "feat(wnba): add /api/grade/wnba route (writes wnba_prop_grades)"
```

---

## Task 5: WNBA grade step in the daily workflow

**Files:**
- Modify: `.github/workflows/daily-stats.yml`

- [ ] **Step 1: Locate the NBA grade step**

Run: `cd /c/Users/dcho0/nbaiqproject && grep -n "api/grade" .github/workflows/daily-stats.yml`
Expected: shows the NBA grade curl step(s) (e.g. `"$VERCEL_APP_URL/api/grade"`). Note the step that hits `/api/grade` (the main nightly grade).

- [ ] **Step 2: Add a WNBA grade step after the NBA `/api/grade` step**

In `.github/workflows/daily-stats.yml`, immediately after the block of the step that curls `"$VERCEL_APP_URL/api/grade"` (the main grade step — NOT `/api/feed/grade`), insert:

```yaml
      - name: Grade WNBA props
        continue-on-error: true   # WNBA is isolated — must never disturb the NBA pipeline
        env:
          VERCEL_APP_URL: ${{ secrets.VERCEL_APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
        run: |
          echo "Grading WNBA props..."
          curl -sf --max-time 120 \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$VERCEL_APP_URL/api/grade/wnba" | head -c 300
          echo ""
```

- [ ] **Step 3: Validate YAML**

Run: `cd /c/Users/dcho0/nbaiqproject && python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/daily-stats.yml')); names=[s.get('name') for s in d['jobs']['refresh']['steps']]; assert 'Grade WNBA props' in names, names; print('WNBA grade step present; YAML valid')"`
Expected: `WNBA grade step present; YAML valid`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/daily-stats.yml
git commit -m "feat(wnba): grade WNBA props in the daily workflow (isolated)"
```

---

## Task 6: Full verification + production deploy (gated on user go)

**Files:** none (verification + deploy).

- [ ] **Step 1: Full TS suite + typecheck + build**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run 2>&1 | tail -4 && npx tsc --noEmit 2>&1 | tail -3 && echo TSC_OK && npx next build >/dev/null 2>&1 && echo BUILD_OK`
Expected: all vitest pass; `TSC_OK`; `BUILD_OK`.

- [ ] **Step 2: Full Python suite (unaffected, sanity)**

Run: `cd /c/Users/dcho0/nbaiqproject/scripts && python3 -m pytest tests/ -q 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 3: Confirm `wnba_prop_grades` exists (Task 1 applied)**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']
print('wnba_prop_grades ->', requests.get(f'{U}/rest/v1/wnba_prop_grades?limit=0',headers={'apikey':K,'Authorization':f'Bearer {K}'},timeout=20).status_code)
"
```
Expected: `-> 200`.

- [ ] **Step 4: Deploy to production (CONFIRM WITH USER FIRST)**

This ships the entire held stack (SP1a props, SP1b stats workflow, calibration tiers, SP2 grading). Get explicit user go, then:
```bash
cd /c/Users/dcho0/nbaiqproject && git push origin master && npx vercel --prod --yes 2>&1 | tail -6
```
Expected: `● Ready`, `target: production`, aliased to `prizmproject.vercel.app`.

- [ ] **Step 5: Live smoke — WNBA props refresh + grade run without error**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SITE_URL|CRON_SECRET)=' .env.local | sed 's/\r$//') && set +a && echo "props:" && curl -s --max-time 120 -H "Authorization: Bearer $CRON_SECRET" "$NEXT_PUBLIC_SITE_URL/api/props/wnba?refresh=true" | head -c 160; echo; echo "grade:" && curl -s --max-time 120 -H "Authorization: Bearer $CRON_SECRET" "$NEXT_PUBLIC_SITE_URL/api/grade/wnba" | head -c 200; echo
```
Expected: props returns a JSON slate (or "no upcoming games" on a WNBA off-day); grade returns JSON `{graded, dnp, upserted}` or `{message: "No wnba_prop_history rows…"}` — both 200, no error. (Grades accrue once a refresh→game→grade cycle completes.)

- [ ] **Step 6: Confirm NBA grading unaffected**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']
r=requests.get(f'{U}/rest/v1/prop_grades?select=game_date&order=game_date.desc&limit=1',headers={'apikey':K,'Authorization':f'Bearer {K}'},timeout=20).json()
print('newest NBA prop_grades game_date:', r[0]['game_date'] if r else 'EMPTY')
"
```
Expected: newest NBA grade date unchanged/sane (NBA grading untouched).

---

## Self-Review notes

- **Spec coverage:** `wnba_prop_grades` migration (Task 1); `snapshotUnscored` so WNBA props snapshot for grading (Task 2); league-parameterized `gradeProp`/`gradeLeague`/`GRADE_CONFIGS` + NBA route unchanged behavior (Task 3); `/api/grade/wnba` (Task 4); isolated workflow grade step (Task 5); verify + the SP1a deploy that turns on accumulation (Task 6). Deferred model-comparison backtest is out of scope per the spec.
- **NBA behavior preserved:** `/api/grade` delegates to `gradeLeague(GRADE_CONFIGS.nba)` with `requireLabel:true` + `refreshPerfSnapshot:true` (the perf-snapshot fire-and-forget is preserved, gated to NBA); the snapshot filter only changes when `snapshotUnscored` (WNBA).
- **Type consistency:** `gradeProp(hist, log)→{actual_value,hit}|null`, `gradeLeague(req, GradeConfig)`, `GRADE_CONFIGS` shape (`historyTable/logsTable/gradesTable/requireLabel`) defined in Task 3 and used unchanged in Task 4; `snapshotUnscored?` added in Task 2 and consumed by the snapshot query.
