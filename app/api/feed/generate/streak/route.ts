// /api/feed/generate/streak
// Picks today's single highest-confidence LOCK prop as the daily Prop of the Day.
// Hit → streak continues. Miss → streak resets.
// Stored as a 1-leg curated_parlays entry with parlay_type = 'streak'.
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
  const pass = url.searchParams.get('pass')
  try {
    // Safety guard: abort if today's props haven't been enriched yet
    const { count: scoredCount } = await adminClient
      .from('props')
      .select('id', { count: 'exact', head: true })
      .in('confidence_label', ['LOCK', 'PLAY'])
      .gte('commence_time', `${gameDate}T00:00:00.000Z`)
      .lt('commence_time', `${gameDate}T23:59:59.999Z`)
    if ((scoredCount ?? 0) < 1) {
      return NextResponse.json({
        message: 'Not enough scored props for today — run /api/enrich first',
        scoredCount: scoredCount ?? 0,
        date: gameDate,
      })
    }

    // ── Pass 2: check if morning streak pick needs replacing ────────────────
    if (pass === '2') {
      const { data: morningStreak } = await adminClient
        .from('curated_parlays')
        .select('id, legs, game_date')
        .eq('game_date', gameDate)
        .eq('parlay_type', 'streak')
        .eq('active', true)
        .eq('superseded', false)
        .limit(1)
        .single()

      if (!morningStreak) {
        return NextResponse.json({ message: 'No morning streak pick to re-evaluate', pass: 2, updated: 0 })
      }

      const morningLegs = (morningStreak.legs as Array<Record<string, unknown>>) ?? []
      const morningPlayer = morningLegs[0]?.player_name as string | undefined

      if (!morningPlayer) {
        return NextResponse.json({ message: 'Morning streak has no legs', pass: 2, updated: 0 })
      }

      // Check if the morning pick player is now injured or confidence dropped
      const { data: currentProp } = await supabase
        .from('props')
        .select('player_name, confidence_label, confidence_score, confidence_reason')
        .eq('player_name', morningPlayer)
        .eq('stat_type', morningLegs[0]?.stat_type as string)
        .limit(1)
        .single()

      const isInjured = currentProp?.confidence_reason &&
        /listed as (OUT|DOUBTFUL)/.test(currentProp.confidence_reason as string)
      const scoreDrop = currentProp
        ? (Number(morningLegs[0]?.confidence_score ?? 0) - Number(currentProp.confidence_score ?? 0))
        : 0
      const droppedBelowLock = currentProp?.confidence_label !== 'LOCK'

      if (!isInjured && !droppedBelowLock && scoreDrop < 10) {
        console.log(`[generate/streak] Pass 2: Morning streak pick confirmed (${morningPlayer})`)
        return NextResponse.json({ message: 'Morning streak pick confirmed', pass: 2, updated: 0 })
      }

      // Need to replace — fall through to normal generation, but mark the old one as superseded
      const changeSummary = isInjured
        ? `${morningPlayer} ruled ${currentProp?.confidence_reason?.match(/listed as (OUT|DOUBTFUL)/)?.[1] ?? 'OUT'}`
        : droppedBelowLock
          ? `${morningPlayer} no longer LOCK confidence`
          : `${morningPlayer} confidence dropped significantly`

      // Don't delete — supersede the morning pick, generate new one below
      // (will be inserted with pass=2, replaces_id, change_summary)
      // Store context for after generation
      ;(req as unknown as Record<string, unknown>).__pass2Context = {
        morningId: morningStreak.id,
        changeSummary,
      }
    }

    if (pass !== '2') {
      // Pass 1: Always delete existing streak for the date and regenerate fresh.
      await adminClient
        .from('curated_parlays')
        .delete()
        .eq('game_date', gameDate)
        .eq('parlay_type', 'streak')
        .eq('active', true)
    }

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
    if (todayProps.length < 1) {
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

    // Pick the single highest-confidence LOCK prop (unique player)
    const pick = todayProps[0] ?? null

    if (!pick) {
      return NextResponse.json({ message: 'Not enough qualifying props for Prop of the Day', saved: 0 })
    }

    // ── Build the 1-leg entry ────────────────────────────────────────────────
    const legs = [{
      player_name:      pick.player_name,
      team:             pick.team ?? null,
      stat_type:        pick.stat_type,
      line:             Number(pick.line),
      direction:        pick.direction,
      odds:             pick.odds ?? null,
      confidence_label: pick.confidence_label,
      confidence_score: pick.confidence_score,
    }]

    const legDesc = `${pick.player_name} ${pick.direction.toUpperCase()} ${pick.line} ${STAT_LABELS[pick.stat_type] ?? pick.stat_type}`

    // Pass 2 context (set above when replacing a morning pick)
    const pass2Ctx = (req as unknown as Record<string, unknown>).__pass2Context as
      { morningId: string; changeSummary: string } | undefined

    const insertRow: Record<string, unknown> = {
      title:          `Prop of the Day · ${gameDate}`,
      description:    legDesc,
      parlay_type:    'streak',
      game_date:      gameDate,
      est_multiplier: null,
      legs,
      active:         true,
      pass:           pass2Ctx ? 2 : 1,
      superseded:     false,
    }

    if (pass2Ctx) {
      insertRow.replaces_id    = pass2Ctx.morningId
      insertRow.change_summary = pass2Ctx.changeSummary
    }

    const { error } = await adminClient.from('curated_parlays').insert(insertRow)

    // If Pass 2, mark the morning pick as superseded
    if (pass2Ctx && !error) {
      await adminClient
        .from('curated_parlays')
        .update({ superseded: true })
        .eq('id', pass2Ctx.morningId)
    }

    if (error) {
      console.error('[generate/streak] insert error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`[generate/streak] Saved Prop of the Day for ${gameDate}: ${legDesc}`)
    return NextResponse.json({ message: 'Prop of the Day saved', saved: 1, date: gameDate, pick: legDesc })

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[generate/streak] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
