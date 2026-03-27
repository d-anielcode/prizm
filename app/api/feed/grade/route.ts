// /api/feed/grade — Grade settled curated_parlays and store results
export const maxDuration = 60
//
// GET  — preview grading for all ungraded past parlays (no DB writes)
// POST — grade and persist result to curated_parlays.result
//
// Runs as a nightly cron after game logs are fetched (04:15 UTC).
// A parlay is:
//   hit  — every leg hit
//   miss — at least one leg missed
//   void — at least one leg had no game log or player DNP (< 5 min)
//          AND no legs missed (if any leg clearly missed, we call it miss)

import { NextResponse } from 'next/server'
import { createClient }  from '@supabase/supabase-js'
import { supabase }      from '@/lib/supabase'
import type { StatType } from '@/types'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

// ── Helpers ────────────────────────────────────────────────────────────────────

function getActualValue(log: Record<string, unknown>, statType: string): number | null {
  switch (statType as StatType) {
    case 'points':         return Number(log.points    ?? 0)
    case 'rebounds':       return Number(log.rebounds  ?? 0)
    case 'assists':        return Number(log.assists   ?? 0)
    case 'steals':         return Number(log.steals    ?? 0)
    case 'blocks':         return Number(log.blocks    ?? 0)
    case 'three_pointers': return Number(log.fg3m      ?? 0)
    case 'pra':            return Number(log.pra       ?? 0)
    default:               return null
  }
}

// ── Core grading logic ────────────────────────────────────────────────────────

interface LegGrade {
  player_name: string
  stat_type:   string
  line:        number
  direction:   string
  actual:      number | null
  hit:         boolean | null  // null = no data / DNP
}

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
  const { data: parlays, error } = await supabase
    .from('curated_parlays')
    .select('id, title, game_date, legs')
    .eq('active', true)
    .is('result', null)
    .lt('game_date', today)
    .in('parlay_type', ['value', 'premium', 'jackpot', 'streak'])
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

  const grades: ParlayGrade[] = []

  for (const p of parlays) {
    const rawLegs = (p.legs as Array<Record<string, unknown>>) ?? []
    const legGrades: LegGrade[] = []

    for (const l of rawLegs) {
      const log   = logIndex.get(`${l.player_name}|${p.game_date}`)
      const mins  = log ? Number(log.minutes ?? 0) : null
      const isDnp = mins !== null && mins < 5

      const actual = (!log || isDnp) ? null : getActualValue(log, l.stat_type as string)
      const hit    = actual === null ? null
        : l.direction === 'over' ? actual > Number(l.line) : actual < Number(l.line)

      legGrades.push({
        player_name: l.player_name as string,
        stat_type:   l.stat_type   as string,
        line:        Number(l.line),
        direction:   l.direction   as string,
        actual,
        hit,
      })
    }

    // Determine overall parlay result
    const anyMissed = legGrades.some((l) => l.hit === false)
    const allHit    = legGrades.every((l) => l.hit === true)
    const result: 'hit' | 'miss' | 'void' = anyMissed ? 'miss' : allHit ? 'hit' : 'void'

    grades.push({ id: p.id as string, game_date: p.game_date as string, title: p.title as string, legs: legGrades, result })
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
