// /api/performance-snapshot
// Pre-computes and stores the Props History tab data (totals, daily breakdown, calibration).
// Called fire-and-forget at the end of /api/grade so the performance page reads a single
// fast SELECT instead of paginating through thousands of prop_grades rows on every visit.
//
// Table: performance_snapshot (id=1, single upsert)
//   id          integer primary key default 1
//   computed_at timestamptz not null default now()
//   totals      jsonb not null
//   days        integer not null default 0
//   daily_breakdown jsonb not null
//   calibration jsonb

import { NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { requireCronAuth } from '@/lib/api-auth'
import { applyCalibration } from '@/lib/calibration'

export const maxDuration = 120

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, any, any>

function getServiceClient(): DB {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

// ── Types (mirrors performance/page.tsx) ──────────────────────────────────────
type Tally = { total: number; hits: number }
type TierMap = Record<string, Tally>

function blankTierMap(): TierMap {
  return { LOCK: { total: 0, hits: 0 }, PLAY: { total: 0, hits: 0 }, LEAN: { total: 0, hits: 0 }, FADE: { total: 0, hits: 0 }, ALL: { total: 0, hits: 0 } }
}

function tally(map: TierMap, label: string, hit: boolean) {
  if (map[label]) { map[label].total++; if (hit) map[label].hits++ }
  map.ALL.total++; if (hit) map.ALL.hits++
}

const CALIB_BUCKETS = [
  { label: '50–54', min: 50, max: 54 }, { label: '55–59', min: 55, max: 59 },
  { label: '60–64', min: 60, max: 64 }, { label: '65–69', min: 65, max: 69 },
  { label: '70–74', min: 70, max: 74 }, { label: '75–79', min: 75, max: 79 },
  { label: '80–84', min: 80, max: 84 }, { label: '85+',   min: 85, max: 99 },
]

// ── Queries ───────────────────────────────────────────────────────────────────

async function computeAllTimeTotals(db: DB) {
  const totals = blankTierMap()
  const dates  = new Set<string>()
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: page } = await db
      .from('prop_grades')
      .select('game_date, confidence_label, hit')
      .not('confidence_label', 'is', null)
      .not('hit', 'is', null)
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    for (const row of page as { game_date: string; confidence_label: string; hit: boolean }[]) {
      tally(totals, row.confidence_label, row.hit)
      dates.add(row.game_date)
    }
    if (page.length < PAGE) break
    from += PAGE
  }
  return { totals, days: dates.size }
}

async function computeDailyBreakdown(db: DB) {
  const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const cutoff = new Date(Date.now() - 10 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  const { data } = await db
    .from('prop_grades')
    .select('game_date, confidence_label, hit')
    .not('confidence_label', 'is', null)
    .not('hit', 'is', null)
    .gte('game_date', cutoff)
    .lte('game_date', today)
    .order('game_date', { ascending: false })
    .limit(5000)

  const byDate = new Map<string, TierMap>()
  for (const row of (data ?? []) as { game_date: string; confidence_label: string; hit: boolean }[]) {
    if (!byDate.has(row.game_date)) byDate.set(row.game_date, blankTierMap())
    tally(byDate.get(row.game_date)!, row.confidence_label, row.hit)
  }

  const top5 = [...byDate.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 5)
  return top5.map((d) => ({ date: d, tiers: byDate.get(d)! }))
}

async function computeCalibration(db: DB) {
  const rows: { confidence_score: number; confidence_label: string; direction: string; stat_type: string; hit: boolean }[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: page } = await db
      .from('prop_grades')
      .select('confidence_score, confidence_label, direction, stat_type, hit')
      .not('confidence_score', 'is', null)
      .not('hit', 'is', null)
      .range(from, from + PAGE - 1)
    if (!page || page.length === 0) break
    rows.push(...(page as typeof rows))
    if (page.length < PAGE) break
    from += PAGE
  }

  // Bucketize on the CALIBRATED score so the histogram shows honest hit-rate
  // bands. Stored confidence_score is raw; applyCalibration() does the remap.
  const buckets = CALIB_BUCKETS.map((b) => {
    const inBucket = rows.filter((r) => {
      const cal = applyCalibration(r.confidence_score)
      return cal >= b.min && cal <= b.max
    })
    return { ...b, hits: inBucket.filter((r) => r.hit).length, total: inBucket.length }
  })

  const byDirection = {
    over:  { hits: rows.filter((r) => r.direction === 'over'  && r.hit).length, total: rows.filter((r) => r.direction === 'over').length },
    under: { hits: rows.filter((r) => r.direction === 'under' && r.hit).length, total: rows.filter((r) => r.direction === 'under').length },
  }

  const byLabelDir: Record<string, { over: { hits: number; total: number }; under: { hits: number; total: number } }> = {}
  for (const label of ['LOCK', 'PLAY', 'LEAN', 'FADE']) {
    const sub = rows.filter((r) => r.confidence_label === label)
    byLabelDir[label] = {
      over:  { hits: sub.filter((r) => r.direction === 'over'  && r.hit).length, total: sub.filter((r) => r.direction === 'over').length },
      under: { hits: sub.filter((r) => r.direction === 'under' && r.hit).length, total: sub.filter((r) => r.direction === 'under').length },
    }
  }

  const byStatType: Record<string, { hits: number; total: number }> = {}
  for (const r of rows) {
    if (!byStatType[r.stat_type]) byStatType[r.stat_type] = { hits: 0, total: 0 }
    byStatType[r.stat_type].total++
    if (r.hit) byStatType[r.stat_type].hits++
  }

  const overRate  = byDirection.over.total  > 0 ? byDirection.over.hits  / byDirection.over.total  : null
  const underRate = byDirection.under.total > 0 ? byDirection.under.hits / byDirection.under.total : null
  const gap = (overRate != null && underRate != null) ? underRate - overRate : 0
  const recommendedOverAdj = gap > 0 ? -Math.round(gap * 100) : 0

  return { buckets, byDirection, byLabelDir, byStatType, recommendedOverAdj, currentOverAdj: -3, sampleSize: rows.length }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const db = getServiceClient()

    const [{ totals, days }, dailyBreakdown, calibration] = await Promise.all([
      computeAllTimeTotals(db),
      computeDailyBreakdown(db),
      computeCalibration(db),
    ])

    const { error } = await db
      .from('performance_snapshot')
      .upsert({
        id: 1,
        computed_at: new Date().toISOString(),
        totals,
        days,
        daily_breakdown: dailyBreakdown,
        calibration,
      })

    if (error) {
      console.error('[performance-snapshot] upsert error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`[performance-snapshot] stored: ${totals.ALL.total} props graded, ${days} days`)
    return NextResponse.json({ ok: true, total: totals.ALL.total, days })
  } catch (err) {
    console.error('[performance-snapshot] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
