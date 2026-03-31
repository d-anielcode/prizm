// /api/feed/generate/streak
// Picks today's 2 highest-confidence props as the daily streak picks.
// Both legs must hit to continue the streak. Either misses → streak resets.
// Stored as a single 2-leg curated_parlays entry with parlay_type = 'streak'.
// Idempotent by default. Pass ?force=true to delete and regenerate.

export const maxDuration = 60

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabase }     from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

const STAT_LABELS: Record<string, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

function toEasternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url      = new URL(req.url)
  const gameDate = url.searchParams.get('date')
    ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  try {
    // Safety guard: abort if enrich hasn't run yet
    const { count: scoredCount } = await adminClient
      .from('props')
      .select('id', { count: 'exact', head: true })
      .in('confidence_label', ['LOCK', 'PLAY'])
    if ((scoredCount ?? 0) < 10) {
      return NextResponse.json({
        message: 'Not enough scored props — run /api/enrich first',
        scoredCount: scoredCount ?? 0,
      })
    }

    // Always delete existing streak for the date and regenerate fresh.
    await adminClient
      .from('curated_parlays')
      .delete()
      .eq('game_date', gameDate)
      .eq('parlay_type', 'streak')
      .eq('active', true)

    // ── Fetch today's LOCK props, sorted by confidence desc ─────────────────
    // Exclude STL/BLK — integer stats with too much game-to-game variance for a
    // "high confidence" daily challenge. Focus on PTS/REB/AST/3PM/PRA.
    const STREAK_EXCLUDED_STATS = new Set(['steals', 'blocks'])

    const { data: propsRaw } = await supabase
      .from('props')
      .select('player_name, team, stat_type, line, direction, confidence_score, confidence_label, odds, commence_time')
      .eq('confidence_label', 'LOCK')
      .order('confidence_score', { ascending: false })

    const todayProps = (propsRaw ?? []).filter((p) =>
      p.commence_time &&
      toEasternDate(p.commence_time) === gameDate &&
      !STREAK_EXCLUDED_STATS.has(p.stat_type)
    )

    // Fall back to LOCK+PLAY if not enough LOCKs after exclusions
    if (todayProps.length < 2) {
      const { data: playProps } = await supabase
        .from('props')
        .select('player_name, team, stat_type, line, direction, confidence_score, confidence_label, odds, commence_time')
        .in('confidence_label', ['LOCK', 'PLAY'])
        .order('confidence_score', { ascending: false })
      const playToday = (playProps ?? []).filter((p) =>
        p.commence_time &&
        toEasternDate(p.commence_time) === gameDate &&
        !STREAK_EXCLUDED_STATS.has(p.stat_type)
      )
      todayProps.push(...playToday.filter((p) => !todayProps.find((e) => e.player_name === p.player_name)))
    }

    // Pick top 2 unique players, enforcing at least 1 OVER.
    // Strategy: greedily pick by confidence, then if both are UNDERs,
    // swap the lower-confidence one for the best available OVER.
    const seen = new Set<string>()
    const picks: typeof todayProps = []
    for (const p of todayProps) {
      if (seen.has(p.player_name)) continue
      seen.add(p.player_name)
      picks.push(p)
      if (picks.length === 2) break
    }

    // Enforce at least 1 OVER — if both are UNDERs, replace the lower-confidence
    // one with the highest-confidence OVER from a different player
    if (picks.length === 2 && picks.every((p) => p.direction === 'under')) {
      const pickedPlayers = new Set(picks.map((p) => p.player_name))
      const bestOver = todayProps.find(
        (p) => p.direction === 'over' && !pickedPlayers.has(p.player_name)
      )
      if (bestOver) {
        // Replace the lower-confidence UNDER (index 1, since sorted desc)
        picks[1] = bestOver
      }
    }

    if (picks.length < 2) {
      return NextResponse.json({ message: 'Not enough qualifying props for streak picks', saved: 0 })
    }

    // ── Build the 2-leg entry ────────────────────────────────────────────────
    const legs = picks.map((p) => ({
      player_name:      p.player_name,
      team:             p.team ?? null,
      stat_type:        p.stat_type,
      line:             Number(p.line),
      direction:        p.direction,
      odds:             p.odds ?? null,
      confidence_label: p.confidence_label,
      confidence_score: p.confidence_score,
    }))

    const legDesc = picks.map((p) =>
      `${p.player_name} ${p.direction.toUpperCase()} ${p.line} ${STAT_LABELS[p.stat_type] ?? p.stat_type}`
    ).join(' · ')

    const { error } = await adminClient.from('curated_parlays').insert({
      title:         `Streak Picks · ${gameDate}`,
      description:   legDesc,
      parlay_type:   'streak',
      game_date:     gameDate,
      est_multiplier: null,
      legs,
      active:        true,
    })

    if (error) {
      console.error('[generate/streak] insert error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`[generate/streak] Saved streak picks for ${gameDate}: ${legDesc}`)
    return NextResponse.json({ message: 'Streak picks saved', saved: 1, date: gameDate, picks: legDesc })

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[generate/streak] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
