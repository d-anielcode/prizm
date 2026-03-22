// /api/grade/analyze — Real production accuracy breakdown from prop_grades
//
// Returns hit rates segmented by stat_type × confidence_label, overall tier
// totals, per-day accuracy, and a hotStats list (stat types where LOCK is
// performing well enough to lean into in parlay construction).
//
// GET ?days=30   — last N days (default 30)
// GET ?days=90   — last 90 days (broader signal)

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const maxDuration = 60

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

// A stat type qualifies as "hot" (parlay-preferred) when its LOCK hit rate
// over the window is >= this threshold with enough samples.
const HOT_LOCK_THRESHOLD = 0.62  // 62%+ LOCK hit rate
const HOT_MIN_SAMPLES    = 10    // minimum graded LOCK props to count

type GradeRow = {
  stat_type:        string
  confidence_label: string
  confidence_score: number
  game_date:        string
  result:           'hit' | 'miss' | 'dnp'
}

type Tally = { hits: number; total: number }
type Segment = { hits: number; total: number; hitRate: number }

function tally(): Tally { return { hits: 0, total: 0 } }

function toSeg(t: Tally): Segment {
  return { hits: t.hits, total: t.total, hitRate: t.total > 0 ? t.hits / t.total : 0 }
}

export async function GET(req: Request) {
  const db = getServiceClient()
  const { searchParams } = new URL(req.url)
  const days    = Math.min(Number(searchParams.get('days') ?? 30), 365)
  const minDate = new Date(Date.now() - days * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // Load all graded props in window (hit + miss; exclude dnp)
  const PAGE = 1000
  const rows: GradeRow[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('prop_grades')
      .select('stat_type, confidence_label, confidence_score, game_date, result')
      .gte('game_date', minDate)
      .in('result', ['hit', 'miss'])
      .order('game_date', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    rows.push(...(data as GradeRow[]))
    if (data.length < PAGE) break
    from += PAGE
  }

  if (rows.length === 0) {
    return NextResponse.json({
      rows:       0,
      dateRange:  { start: minDate, end: minDate, days, totalDates: 0 },
      byTier:     {},
      byStat:     {},
      byStatTier: {},
      byDay:      {},
      hotStats:   [],
      message:    'No graded props found — pipeline may be too new or prop_grades is empty.',
    })
  }

  // ── Accumulators ──────────────────────────────────────────────────────────
  const byStatTier = new Map<string, Tally>()  // "points|LOCK" → tally
  const byStat     = new Map<string, Tally>()  // "points" → tally
  const byTier     = new Map<string, Tally>()  // "LOCK" → tally
  const byDay      = new Map<string, Tally>()  // "2026-03-22" → tally

  for (const row of rows) {
    const hit = row.result === 'hit' ? 1 : 0

    const stKey = `${row.stat_type}|${row.confidence_label}`
    if (!byStatTier.has(stKey)) byStatTier.set(stKey, tally())
    byStatTier.get(stKey)!.hits  += hit
    byStatTier.get(stKey)!.total += 1

    if (!byStat.has(row.stat_type)) byStat.set(row.stat_type, tally())
    byStat.get(row.stat_type)!.hits  += hit
    byStat.get(row.stat_type)!.total += 1

    if (!byTier.has(row.confidence_label)) byTier.set(row.confidence_label, tally())
    byTier.get(row.confidence_label)!.hits  += hit
    byTier.get(row.confidence_label)!.total += 1

    if (!byDay.has(row.game_date)) byDay.set(row.game_date, tally())
    byDay.get(row.game_date)!.hits  += hit
    byDay.get(row.game_date)!.total += 1
  }

  // ── Hot stats — stat types where LOCK is outperforming recently ───────────
  // Sorted by LOCK hit rate desc for transparency.
  const hotStats: Array<{ stat: string; hitRate: number; hits: number; total: number }> = []
  for (const [stat] of byStat) {
    const lockSeg = byStatTier.get(`${stat}|LOCK`)
    if (!lockSeg || lockSeg.total < HOT_MIN_SAMPLES) continue
    const hr = lockSeg.hits / lockSeg.total
    if (hr >= HOT_LOCK_THRESHOLD) {
      hotStats.push({ stat, hitRate: hr, hits: lockSeg.hits, total: lockSeg.total })
    }
  }
  hotStats.sort((a, b) => b.hitRate - a.hitRate)

  const dates = [...byDay.keys()].sort()

  return NextResponse.json({
    rows: rows.length,
    dateRange: {
      start:      dates[0] ?? minDate,
      end:        dates[dates.length - 1] ?? minDate,
      days,
      totalDates: dates.length,
    },
    byTier:     Object.fromEntries([...byTier.entries()].map(([k, v]) => [k, toSeg(v)])),
    byStat:     Object.fromEntries([...byStat.entries()].map(([k, v]) => [k, toSeg(v)])),
    byStatTier: Object.fromEntries([...byStatTier.entries()].map(([k, v]) => [k, toSeg(v)])),
    byDay:      Object.fromEntries([...byDay.entries()].map(([k, v]) => [k, toSeg(v)])),
    // List of stat names (strings) where LOCK >= 62% with 10+ samples
    hotStats:   hotStats.map((h) => h.stat),
    // Full detail for display/debugging
    hotStatsDetail: hotStats,
  })
}
