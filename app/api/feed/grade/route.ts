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
import { gradeParlay, type LegGrade, type ParlayLeg } from '@/lib/parlay-grade'
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

  // Collect all player/date combos we need
  const playerNames = new Set<string>()
  const gameDates   = new Set<string>()
  for (const p of parlays) {
    const legs = (p.legs as Array<Record<string, unknown>>) ?? []
    for (const l of legs) playerNames.add(l.player_name as string)
    gameDates.add(p.game_date as string)
  }

  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
    .in('player_name', [...playerNames])
    .in('game_date',   [...gameDates])

  const logIndex = new Map<string, Record<string, unknown>>()
  for (const log of logsRaw ?? []) {
    logIndex.set(`${log.player_name}|${log.game_date}`, log as Record<string, unknown>)
  }

  // A date is gradable only once its box scores are in. This cron can fire before
  // /api/gamelogs (Hobby crons run anywhere in their hour); grading then voided
  // every leg as "DNP" and the parlay was never retried.
  const datesWithLogs = new Set<string>()
  for (const d of gameDates) {
    const { data } = await supabase.from('player_game_logs').select('id').eq('game_date', d).limit(1)
    if (data && data.length > 0) datesWithLogs.add(d)
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
