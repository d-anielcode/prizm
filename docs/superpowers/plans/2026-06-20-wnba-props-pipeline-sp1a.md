# WNBA Props Pipeline (SP1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land live WNBA player props in league-separated `wnba_*` tables, with the NBA props path 100% unchanged and no WNBA scoring.

**Architecture:** Additive Supabase migration creates `wnba_props`/`wnba_prop_alts`/`wnba_prop_history` as exact mirrors of the NBA tables (`CREATE TABLE … LIKE … INCLUDING ALL`). The odds-api event fetch is generalized to any league list (NBA keeps its slugs; WNBA adds `usa-wnba`). The props route's request handler is extracted into a league-parameterized helper (`lib/props-refresh.ts`); `/api/props` calls it with the NBA config (behavior identical), and a new `/api/props/wnba` calls it with the WNBA config. A `continue-on-error` workflow step refreshes WNBA props after the NBA steps.

**Tech Stack:** Next 16 / TypeScript, vitest; Supabase (PostgREST). TS tests via `npx vitest run`. This is SP1a of the WNBA pivot; SP1b (stats fetch) and SP2–4 are separate plans.

**Spec:** `docs/superpowers/specs/2026-06-20-wnba-data-foundation-design.md`

---

## File Structure

- Migration (SQL, run via `supabase db push`/editor): `supabase/migrations/<ts>_wnba_props_tables.sql` — creates `wnba_props`, `wnba_prop_alts`, `wnba_prop_history`.
- Modify: `lib/odds-api.ts` — generalize event fetch to a league list; add `fetchTodaysWNBAEvents`.
- Create: `lib/props-refresh.ts` — `LeaguePropConfig`, `LEAGUE_PROP_CONFIGS`, and the extracted `handlePropsRequest(req, cfg)` (+ internal `fetchAndCacheFreshProps`, `allGamesStarted`).
- Modify: `app/api/props/route.ts` — thin wrapper calling `handlePropsRequest(req, LEAGUE_PROP_CONFIGS.nba)`.
- Create: `app/api/props/wnba/route.ts` — thin wrapper with the WNBA config.
- Modify: `.github/workflows/daily-stats.yml` — WNBA props refresh step (continue-on-error, after NBA).
- Create: `lib/__tests__/props-refresh.test.ts`, extend `lib/__tests__/odds-api.test.ts`.

**Test command:** `cd /c/Users/dcho0/nbaiqproject && npx vitest run`. Commit messages end with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`. Do not push.

---

## Task 1: Additive migration — wnba_props / wnba_prop_alts / wnba_prop_history

**Files:**
- Create: `supabase/migrations/20260620120000_wnba_props_tables.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260620120000_wnba_props_tables.sql`:

```sql
-- WNBA props pipeline (SP1a): exact mirrors of the NBA prop tables.
-- CREATE TABLE ... LIKE ... INCLUDING ALL copies columns, defaults, indexes,
-- constraints. Purely additive — no NBA table is touched.
CREATE TABLE IF NOT EXISTS wnba_props        (LIKE props        INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_prop_alts    (LIKE prop_alts    INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_prop_history (LIKE prop_history INCLUDING ALL);
```

- [ ] **Step 2: Apply the migration**

Run (DDL must go through Supabase, not REST):
```bash
cd /c/Users/dcho0/nbaiqproject && supabase db push
```
Expected: applies `20260620120000_wnba_props_tables.sql` with no error. (If `supabase db push` is unavailable, paste the SQL into the Supabase SQL editor.)

- [ ] **Step 3: Verify the tables exist with mirrored columns**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}'}
for t in ['wnba_props','wnba_prop_alts','wnba_prop_history']:
    r=requests.get(f'{U}/rest/v1/{t}?limit=0',headers=H,timeout=20)
    print(t, '->', r.status_code)
"
```
Expected: each prints `-> 200` (table exists, empty). A 404 means the migration didn't apply or PostgREST hasn't reloaded its schema cache (in the dashboard: API → Reload schema).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620120000_wnba_props_tables.sql
git commit -m "feat(wnba): additive migration for wnba_props/prop_alts/prop_history"
```

---

## Task 2: Generalize odds-api event fetch by league

**Files:**
- Modify: `lib/odds-api.ts`
- Modify: `lib/__tests__/odds-api.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/odds-api.test.ts`:

```typescript
import { fetchEventsForLeagues, fetchTodaysWNBAEvents } from '../odds-api'

describe('fetchEventsForLeagues', () => {
  it('throws when given no leagues (all-leagues-failed guard)', async () => {
    await expect(fetchEventsForLeagues([])).rejects.toThrow(/failed for all leagues/i)
  })
  it('exposes a WNBA convenience wrapper', () => {
    expect(typeof fetchTodaysWNBAEvents).toBe('function')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/odds-api.test.ts`
Expected: FAIL — `fetchEventsForLeagues` / `fetchTodaysWNBAEvents` not exported.

- [ ] **Step 3: Implement**

In `lib/odds-api.ts`, replace the existing `NBA_LEAGUES` const + `fetchTodaysNBAEvents` function (the const at ~line 102 and the `export async function fetchTodaysNBAEvents` block at ~lines 133-161) with:

```typescript
const NBA_LEAGUES = ['usa-nba', 'usa-nba-playoffs'] as const
const WNBA_LEAGUES = ['usa-wnba'] as const

// Step 1: Get the next pending slate for the given league slugs (one request per slug).
export async function fetchEventsForLeagues(leagues: readonly string[]): Promise<NBAEvent[]> {
  const all: IOEvent[] = []
  let okCount = 0
  let lastErr = ''

  for (const league of leagues) {
    const url = `${BASE_URL}/events?apiKey=${apiKey()}&sport=basketball&league=${league}&status=pending`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      lastErr = `${league}: ${res.status} ${await res.text()}`
      console.error(`[odds-api] events failed — ${lastErr}`)
      continue
    }
    okCount++
    const data = await res.json() as { data?: IOEvent[] } | IOEvent[]
    const events: IOEvent[] = Array.isArray(data) ? data : (data.data ?? [])
    all.push(...events)
  }

  // Throw only if EVERY league query failed (a real API/key outage). A single
  // empty/404 slug (e.g. usa-nba during the playoffs) is normal and tolerated.
  if (okCount === 0) throw new Error(`odds-api.io events failed for all leagues: ${lastErr}`)

  const slate = selectEarliestSlate(all)
  const date = slate[0]?.commence_time ? toEasternDate(slate[0].commence_time) : 'n/a'
  console.log(`[odds-api] ${all.length} pending events across ${okCount} league(s) — filtered to ${slate.length} on ${date} ET`)
  return slate
}

export const fetchTodaysNBAEvents = (): Promise<NBAEvent[]> => fetchEventsForLeagues(NBA_LEAGUES)
export const fetchTodaysWNBAEvents = (): Promise<NBAEvent[]> => fetchEventsForLeagues(WNBA_LEAGUES)
```

(`fetchTodaysNBAEvents` keeps its name + signature, so its existing call site is unaffected. `toEasternDate` and `selectEarliestSlate` already exist in this file.)

- [ ] **Step 4: Run to verify pass**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/odds-api.test.ts`
Expected: PASS (existing odds-api tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add lib/odds-api.ts lib/__tests__/odds-api.test.ts
git commit -m "feat(odds): generalize event fetch by league; add WNBA wrapper"
```

---

## Task 3: Extract league-parameterized props-refresh helper

**Files:**
- Create: `lib/props-refresh.ts`
- Create: `lib/__tests__/props-refresh.test.ts`
- Modify: `app/api/props/route.ts`

- [ ] **Step 1: Write the failing test for the config map**

Create `lib/__tests__/props-refresh.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { LEAGUE_PROP_CONFIGS } from '../props-refresh'

describe('LEAGUE_PROP_CONFIGS', () => {
  it('NBA config targets the NBA tables', () => {
    const c = LEAGUE_PROP_CONFIGS.nba
    expect([c.propsTable, c.altsTable, c.historyTable]).toEqual(['props', 'prop_alts', 'prop_history'])
  })
  it('WNBA config targets the wnba_* tables', () => {
    const c = LEAGUE_PROP_CONFIGS.wnba
    expect([c.propsTable, c.altsTable, c.historyTable]).toEqual(['wnba_props', 'wnba_prop_alts', 'wnba_prop_history'])
  })
  it('each config carries an events fetcher and league tag', () => {
    expect(LEAGUE_PROP_CONFIGS.nba.league).toBe('nba')
    expect(typeof LEAGUE_PROP_CONFIGS.wnba.fetchEvents).toBe('function')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/props-refresh.test.ts`
Expected: FAIL — `No module … props-refresh`.

- [ ] **Step 3: Create `lib/props-refresh.ts` by moving the route logic, parameterized**

Create `lib/props-refresh.ts` with the content below. It is the existing `allGamesStarted` + `fetchAndCacheFreshProps` + `GET` body from `app/api/props/route.ts`, with every hardcoded `'props'`/`'prop_alts'`/`'prop_history'` replaced by `cfg.propsTable`/`cfg.altsTable`/`cfg.historyTable` and `fetchTodaysNBAEvents()` replaced by `cfg.fetchEvents()`:

```typescript
// League-parameterized props fetch/cache. /api/props (NBA) and /api/props/wnba
// both call handlePropsRequest with their league config — one implementation.
import { NextResponse } from 'next/server'
import { supabase, isCacheStale, safeQuery } from '@/lib/supabase'
import { fetchTodaysNBAEvents, fetchTodaysWNBAEvents, fetchAllPropsForEvents, type NBAEvent } from '@/lib/odds-api'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'
import { deduplicatePropsWithAlts } from '@/lib/dedup'
import type { Prop } from '@/types'

export interface LeaguePropConfig {
  league: 'nba' | 'wnba'
  fetchEvents: () => Promise<NBAEvent[]>
  propsTable: string
  altsTable: string
  historyTable: string
}

export const LEAGUE_PROP_CONFIGS: Record<'nba' | 'wnba', LeaguePropConfig> = {
  nba:  { league: 'nba',  fetchEvents: fetchTodaysNBAEvents,  propsTable: 'props',      altsTable: 'prop_alts',      historyTable: 'prop_history' },
  wnba: { league: 'wnba', fetchEvents: fetchTodaysWNBAEvents, propsTable: 'wnba_props', altsTable: 'wnba_prop_alts', historyTable: 'wnba_prop_history' },
}

function allGamesStarted(props: Prop[]): boolean {
  const withTime = props.filter((p) => p.commence_time)
  if (withTime.length === 0) return false
  const now = Date.now()
  const gameStartTimes = new Map<string, number>()
  for (const p of withTime) {
    if (!gameStartTimes.has(p.game_id)) {
      gameStartTimes.set(p.game_id, new Date(p.commence_time!).getTime())
    }
  }
  return [...gameStartTimes.values()].every((t) => t < now)
}

async function fetchAndCacheFreshProps(cfg: LeaguePropConfig): Promise<Prop[]> {
  const events = await cfg.fetchEvents()
  if (!events || events.length === 0) return []

  const allProps = await fetchAllPropsForEvents(events)
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]))
  for (const prop of allProps) {
    const event = eventMap[prop.game_id]
    if (event) {
      prop.opponent = event.away_team === prop.team ? event.home_team : event.away_team
    }
  }

  const seen = new Set<string>()
  const deduped = allProps.filter((p) => {
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}|${p.sportsbook}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (deduped.length > 0) {
    const dedupedWithAlts = deduplicatePropsWithAlts(deduped)
    const mainProps = dedupedWithAlts.map(({ altLines: _alts, ...p }) => p)
    const now = new Date().toISOString()

    const existing = await safeQuery(
      supabase.from(cfg.propsTable).select('*').not('confidence_label', 'is', null),
      'snapshot existing enriched props'
    )
    if (existing.length > 0) {
      const fallbackDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      const historyRows = existing.map((p: Record<string, unknown>) => {
        const gameDate = p.commence_time
          ? new Date(p.commence_time as string).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
          : fallbackDate
        return { ...p, game_date: gameDate }
      })
      const HBATCH = 500
      for (let i = 0; i < historyRows.length; i += HBATCH) {
        await supabase.from(cfg.historyTable).upsert(historyRows.slice(i, i + HBATCH), { onConflict: 'id,game_date' })
      }
      const dates = [...new Set(historyRows.map((r) => r.game_date))].join(', ')
      console.log(`[/api/props ${cfg.league}] Snapshotted ${existing.length} props to ${cfg.historyTable} for ${dates}`)
    }

    const prevLines = await safeQuery(
      supabase.from(cfg.propsTable).select('player_name, stat_type, direction, line, opening_line'),
      'load prev opening lines'
    )
    const openingLineMap = new Map<string, number>()
    for (const row of prevLines) {
      const key = `${row.player_name}|${row.stat_type}|${row.direction}`
      openingLineMap.set(key, Number((row as Record<string, unknown>).opening_line ?? row.line))
    }

    const BATCH = 500
    const propsWithOpening = mainProps.map((p) => {
      const key = `${p.player_name}|${p.stat_type}|${p.direction}`
      return { ...p, opening_line: openingLineMap.get(key) ?? p.line, cached_at: now }
    })
    for (let i = 0; i < propsWithOpening.length; i += BATCH) {
      const { error } = await supabase.from(cfg.propsTable).upsert(propsWithOpening.slice(i, i + BATCH), { onConflict: 'player_name,stat_type,line,direction,sportsbook' })
      if (error) console.error(`[/api/props ${cfg.league}] props upsert error:`, error.message)
    }
    const { error: sweepErr } = await supabase.from(cfg.propsTable).delete().lt('cached_at', now)
    if (sweepErr) logger.warn(`[/api/props ${cfg.league}] sweep old props failed`, { error: sweepErr.message })

    const STEP: Record<string, number> = {
      points: 2, pra: 2, rebounds: 1, assists: 1, steals: 1, blocks: 1, three_pointers: 1,
    }
    const allAltRows = mainProps.flatMap((p) => {
      const step = STEP[p.stat_type] ?? 1
      return [-1, 1]
        .map((n) => Math.round((p.line + n * step) * 2) / 2)
        .filter((altLine) => altLine >= 0.5)
        .map((altLine) => ({
          player_name:   p.player_name,
          stat_type:     p.stat_type,
          direction:     p.direction,
          game_id:       p.game_id,
          line:          altLine,
          odds:          null,
          sportsbook:    null,
          home_team:     p.home_team ?? null,
          away_team:     p.away_team ?? null,
          commence_time: p.commence_time ?? null,
          cached_at:     now,
        }))
    })
    for (let i = 0; i < allAltRows.length; i += BATCH) {
      const { error } = await supabase.from(cfg.altsTable).upsert(allAltRows.slice(i, i + BATCH), { onConflict: 'player_name,stat_type,line,direction' })
      if (error) console.error(`[/api/props ${cfg.league}] prop_alts upsert error:`, error.message)
    }
    const { error: altSweepErr } = await supabase.from(cfg.altsTable).delete().lt('cached_at', now)
    if (altSweepErr) logger.warn(`[/api/props ${cfg.league}] sweep old alt lines failed`, { error: altSweepErr.message })

    console.log(`[/api/props ${cfg.league}] Refreshed — ${mainProps.length} main props + ${allAltRows.length} alt lines for ${events.length} games`)
  } else {
    console.log(`[/api/props ${cfg.league}] Refreshed — 0 props for ${events.length} games`)
  }
  const times = [...new Set(deduped.map((p) => p.commence_time).filter(Boolean))].sort()
  if (times.length > 0) console.log(`[/api/props ${cfg.league}] Games tip off at: ${times.join(', ')}`)

  return deduped
}

export async function handlePropsRequest(req: Request, cfg: LeaguePropConfig) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const forceRefresh = new URL(req.url).searchParams.get('refresh') === 'true'

    const { data: cached, error: cacheError } = await supabase
      .from(cfg.propsTable)
      .select('*')
      .order('confidence_score', { ascending: false, nullsFirst: false })

    const cachedProps = (cached ?? []) as Prop[]

    const shouldRefresh =
      forceRefresh ||
      cacheError != null ||
      cachedProps.length === 0 ||
      isCacheStale(cachedProps[0]?.cached_at ?? '') ||
      allGamesStarted(cachedProps)

    if (!shouldRefresh) {
      const reason = allGamesStarted(cachedProps) ? 'games_started' : 'cached'
      return NextResponse.json({ props: cachedProps, cached: true, count: cachedProps.length, reason })
    }

    const freshProps = await fetchAndCacheFreshProps(cfg)

    if (freshProps.length === 0) {
      return NextResponse.json({
        props: cachedProps, cached: true, count: cachedProps.length,
        message: 'No upcoming games found — showing last cached props',
      })
    }

    return NextResponse.json({ props: freshProps, cached: false, count: freshProps.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[/api/props ${cfg.league}] Error:`, message)
    return NextResponse.json({ error: 'Failed to fetch props', details: message }, { status: 500 })
  }
}
```

- [ ] **Step 4: Replace `app/api/props/route.ts` with a thin NBA wrapper**

Overwrite `app/api/props/route.ts` with:

```typescript
// /api/props — NBA player props (fetch + cache + snapshot). The league-agnostic
// implementation lives in lib/props-refresh.ts; this route binds it to the NBA config.
import { handlePropsRequest, LEAGUE_PROP_CONFIGS } from '@/lib/props-refresh'

export const maxDuration = 60

export async function GET(req: Request) {
  return handlePropsRequest(req, LEAGUE_PROP_CONFIGS.nba)
}
```

- [ ] **Step 5: Run the config test + full suite + typecheck**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run lib/__tests__/props-refresh.test.ts && npx vitest run && npx tsc --noEmit 2>&1 | tail -5 && echo TSC_DONE`
Expected: props-refresh test passes (3), full vitest suite passes, tsc prints no errors before `TSC_DONE`.

- [ ] **Step 6: Commit**

```bash
git add lib/props-refresh.ts lib/__tests__/props-refresh.test.ts app/api/props/route.ts
git commit -m "refactor(props): extract league-parameterized props-refresh helper"
```

---

## Task 4: Add the /api/props/wnba route

**Files:**
- Create: `app/api/props/wnba/route.ts`

- [ ] **Step 1: Create the WNBA route**

Create `app/api/props/wnba/route.ts`:

```typescript
// /api/props/wnba — WNBA player props. Same implementation as /api/props,
// bound to the WNBA league config (writes wnba_props / wnba_prop_alts).
import { handlePropsRequest, LEAGUE_PROP_CONFIGS } from '@/lib/props-refresh'

export const maxDuration = 60

export async function GET(req: Request) {
  return handlePropsRequest(req, LEAGUE_PROP_CONFIGS.wnba)
}
```

- [ ] **Step 2: Typecheck + build the route**

Run: `cd /c/Users/dcho0/nbaiqproject && npx tsc --noEmit 2>&1 | grep -E "props/wnba|props-refresh" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 3: Commit**

```bash
git add "app/api/props/wnba/route.ts"
git commit -m "feat(wnba): add /api/props/wnba route (writes wnba_props)"
```

---

## Task 5: Add the WNBA props refresh to the daily workflow

**Files:**
- Modify: `.github/workflows/daily-stats.yml`

- [ ] **Step 1: Add a WNBA props step after the NBA "Refresh today's props" step**

In `.github/workflows/daily-stats.yml`, locate the existing NBA step `- name: Refresh today's props from odds API` (it curls `$VERCEL_APP_URL/api/props?refresh=true`). Immediately AFTER that step's block, insert:

```yaml
      - name: Refresh today's WNBA props from odds API
        continue-on-error: true   # WNBA is isolated — must never disturb the NBA pipeline
        env:
          VERCEL_APP_URL: ${{ secrets.VERCEL_APP_URL }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}
        run: |
          echo "Refreshing WNBA props..."
          curl -sf --max-time 120 \
            -H "Authorization: Bearer $CRON_SECRET" \
            "$VERCEL_APP_URL/api/props/wnba?refresh=true" | head -c 300
          echo ""
```

- [ ] **Step 2: Validate the workflow YAML**

Run: `cd /c/Users/dcho0/nbaiqproject && python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/daily-stats.yml')); names=[s.get('name') for s in d['jobs']['refresh']['steps']]; assert \"Refresh today's WNBA props from odds API\" in names, names; print('WNBA step present; steps OK')"`
Expected: `WNBA step present; steps OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/daily-stats.yml
git commit -m "feat(wnba): refresh WNBA props in the daily workflow (isolated)"
```

---

## Task 6: Full verification + live WNBA smoke + NBA non-regression

**Files:** none (verification).

- [ ] **Step 1: Full TS suite + typecheck + build**

Run: `cd /c/Users/dcho0/nbaiqproject && npx vitest run 2>&1 | tail -4 && npx tsc --noEmit 2>&1 | tail -5 && echo TSC_OK && npx next build >/dev/null 2>&1 && echo BUILD_OK`
Expected: all vitest pass; `TSC_OK`; `BUILD_OK`.

- [ ] **Step 2: Capture NBA props row count (pre-deploy baseline)**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}','Prefer':'count=exact','Range':'0-0'}
for t in ['props','wnba_props']:
    print(t, requests.get(f'{U}/rest/v1/{t}?select=id',headers=H,timeout=20).headers.get('content-range'))
"
```
Record the `props` count.

- [ ] **Step 3: Deploy and exercise the live WNBA route**

(Prod does NOT auto-deploy from push — confirm with the user, then.) Run:
```bash
cd /c/Users/dcho0/nbaiqproject && git push origin master && npx vercel --prod --yes 2>&1 | tail -5
```
Then trigger the WNBA refresh:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SITE_URL|CRON_SECRET)=' .env.local | sed 's/\r$//') && set +a && curl -s --max-time 120 -H "Authorization: Bearer $CRON_SECRET" "$NEXT_PUBLIC_SITE_URL/api/props/wnba?refresh=true" | python3 -c "import sys,json; d=json.load(sys.stdin); print('cached:', d.get('cached'), 'count:', d.get('count'), 'msg:', d.get('message',''))"
```
Expected: `cached: False` with a non-zero count (WNBA season is live), or a "no upcoming games" message on a WNBA off-day.

- [ ] **Step 4: Confirm WNBA props landed AND NBA props are unchanged**

Run:
```bash
cd /c/Users/dcho0/nbaiqproject && set -a && source <(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_KEY)=' .env.local | sed 's/\r$//') && set +a && python3 -c "
import requests, os
U=os.environ['NEXT_PUBLIC_SUPABASE_URL']; K=os.environ['SUPABASE_SERVICE_KEY']; H={'apikey':K,'Authorization':f'Bearer {K}'}
w=requests.get(f'{U}/rest/v1/wnba_props?select=player_name,stat_type,line,commence_time&limit=5',headers=H,timeout=20).json()
print('wnba_props sample:', [(x['player_name'], x['stat_type'], x['line']) for x in w])
cc=requests.get(f'{U}/rest/v1/props?select=id',headers={**H,'Prefer':'count=exact','Range':'0-0'},timeout=20).headers.get('content-range')
print('props count now:', cc, '(compare to Step 2 baseline — must be unchanged)')
"
```
Expected: `wnba_props` has real WNBA players; the `props` count matches the Step 2 baseline (NBA untouched).

- [ ] **Step 5: Final commit (only if verification fixups were needed)**

Otherwise no commit.

---

## Self-Review notes

- **Spec coverage (SP1a slice):** additive `wnba_*` migration (Task 1), odds-api `usa-wnba` fetch (Task 2), league-parameterized props helper + `/api/props/wnba` with NBA path unchanged (Tasks 3–4), isolated `continue-on-error` workflow step (Task 5), live verification + NBA non-regression + no-scoring (Task 6). SP1b (stats fetch) and SP2–4 are explicitly out of this plan.
- **No DDL beyond additive CREATE TABLE LIKE; NBA tables untouched.**
- **Type consistency:** `LeaguePropConfig` (`league`, `fetchEvents`, `propsTable`, `altsTable`, `historyTable`) defined in Task 3 and consumed unchanged in Task 4; `fetchEventsForLeagues`/`fetchTodaysWNBAEvents` defined in Task 2 and referenced by `LEAGUE_PROP_CONFIGS` in Task 3; `handlePropsRequest(req, cfg)` signature identical across Tasks 3–4.
