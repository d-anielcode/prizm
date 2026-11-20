// /api/feed/grade — Grade settled curated_parlays and store results
export const maxDuration = 60
//
// GET  — preview grading for all ungraded past parlays (no DB writes)
// POST — grade and persist result to curated_parlays.result
//
// Runs as a nightly cron after game logs are fetched (04:15 UTC).
//
// Sportsbook-accurate void handling:
//   When a player DNPs, sportsbooks void that specific leg (not the whole parlay)
//   and evaluate the remaining legs normally. The parlay only fully voids if
//   ALL legs are void (no playable legs remain).
//
// A parlay is:
//   hit  — all playable legs hit (void legs are removed)
//   miss — at least one playable leg missed
//   void — every leg was void (no playable legs at all)

import { NextResponse } from 'next/server'
import { createClient }  from '@supabase/supabase-js'
import { supabase }      from '@/lib/supabase'
import { gradeParlay, logKey, type LegGrade, type ParlayLeg } from '@/lib/parlay-grade'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

// ── Helpers ────────────────────────────────────────────────────────────────────

interface ParlayGrade {
  id:        string
  game_date: string
  title:     string
  legs:      LegGrade[]
  result:    'hit' | 'miss' | 'void'
}

async function gradePendingParlays(): Promise<ParlayGrade[]> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // Only fetch parlays from past dates with no result yet
  // Only grade the final version of each parlay (non-superseded).
  // Superseded Pass 1 parlays are kept for "original pick" display but never graded.
  const { data: parlays, error } = await supabase
    .from('curated_parlays')
    .select('id, title, game_date, legs')
    .eq('active', true)
    .is('result', null)
    .lt('game_date', today)
    .in('parlay_type', ['value', 'combo', 'premium', 'jackpot', 'streak'])
    .or('superseded.is.null,superseded.eq.false')
    .order('game_date', { ascending: false })
    .limit(100)

  if (error) {
    // Table missing result column yet — will resolve after migration
    if (error.code === '42703') {
      console.warn('/api/feed/grade: curated_parlays missing result column — run curated_parlays_result.sql migration')
    }
    throw new Error(error.message)
  }

  if (!parlays || parlays.length === 0) return []

  // Load each parlay night's box scores by date (not by exact name: legs and logs
  // can spell a player differently, e.g. "Darius Acuff" vs "Darius Acuff Jr.").
  // A date is gradable only once its box scores are in. This cron can fire before
  // /api/gamelogs (Hobby crons run anywhere in their hour); grading then voided
  // every leg as "DNP" and the parlay was never retried.
  const gameDates = [...new Set(parlays.map((p) => p.game_date as string))]
  const logIndex = new Map<string, Record<string, unknown>>()
  const datesWithLogs = new Set<string>()
  for (const d of gameDates) {
    for (let from = 0; ; from += 1000) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
        .eq('game_date', d)
        .order('id')
        .range(from, from + 999)
      for (const log of page ?? []) {
        logIndex.set(logKey(log.player_name as string, d), log as Record<string, unknown>)
        datesWithLogs.add(d)
      }
      if (!page || page.length < 1000) break
    }
  }

  const grades: ParlayGrade[] = []
  for (const p of parlays) {
    const g = gradeParlay((p.legs as ParlayLeg[]) ?? [], p.game_date as string, logIndex, datesWithLogs)
    if (!g) continue  // logs not in yet -> stays pending for the next run
    grades.push({ id: p.id as string, game_date: p.game_date as string, title: p.title as string, legs: g.legs, result: g.result })
  }

  return grades
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET aliases POST so Vercel cron jobs (which always send GET) persist results
export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError
  return POST(req)
}

export async function POST(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError
  try {
    const grades = await gradePendingParlays()

    if (grades.length === 0) {
      return NextResponse.json({ message: 'No ungraded parlays found', updated: 0 })
    }

    const now = new Date().toISOString()
    let updated = 0
    const errors: string[] = []

    for (const g of grades) {
      const { error } = await adminClient
        .from('curated_parlays')
        .update({ result: g.result, graded_at: now })
        .eq('id', g.id)

      if (error) errors.push(`${g.id}: ${error.message}`)
      else updated++
    }

    const summary = { hit: 0, miss: 0, void: 0 }
    for (const g of grades) summary[g.result]++

    return NextResponse.json({
      message: `Graded ${updated} parlay(s)`,
      updated,
      summary,
      ...(errors.length > 0 && { errors }),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
