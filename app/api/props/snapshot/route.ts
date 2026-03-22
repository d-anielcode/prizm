// /api/props/snapshot
//
// Saves the current props table to prop_history without touching the props table.
// Run this BEFORE game tipoffs so tonight's props (with confidence scores) are
// preserved for grading after games complete.
//
// Cron: 23:00 UTC daily = 7:00 PM ET (before any NBA tipoff)
//
// Why a separate endpoint?
//   props?refresh=true snapshots AND replaces props — useful at midnight.
//   This endpoint only snapshots, so it can run safely mid-day without
//   clearing the live props table.
//
// game_date is derived from each prop's commence_time (Eastern date).
// Upserts into prop_history on conflict (id, game_date) — safe to call multiple times.

import { NextResponse } from 'next/server'
import { supabase }     from '@/lib/supabase'

export const maxDuration = 30

export async function GET() {
  try {
    // Load all enriched props (only those with confidence scores are useful for grading).
    // Select only columns that exist in prop_history to avoid schema mismatch errors.
    const { data: existing, error } = await supabase
      .from('props')
      .select('id, player_name, stat_type, direction, line, odds, confidence_score, confidence_label, risk_tier, confidence_reason, commence_time, home_team, away_team, game_id, cached_at')
      .not('confidence_label', 'is', null)

    if (error) throw new Error(`props read: ${error.message}`)

    if (!existing || existing.length === 0) {
      return NextResponse.json({ message: 'No enriched props to snapshot', snapshotted: 0 })
    }

    const fallbackDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const historyRows = existing.map((p: Record<string, unknown>) => {
      const gameDate = p.commence_time
        ? new Date(p.commence_time as string).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
        : fallbackDate
      return { ...p, game_date: gameDate }
    })

    const BATCH = 500
    let snapshotted = 0
    const errors: string[] = []

    for (let i = 0; i < historyRows.length; i += BATCH) {
      const { error: upsertErr } = await supabase
        .from('prop_history')
        .upsert(historyRows.slice(i, i + BATCH), { onConflict: 'id,game_date' })
      if (upsertErr) {
        errors.push(upsertErr.message)
      } else {
        snapshotted += historyRows.slice(i, i + BATCH).length
      }
    }

    const dates = [...new Set(historyRows.map((r) => r.game_date as string))].join(', ')
    console.log(`[/api/props/snapshot] Snapshotted ${snapshotted} props to prop_history for ${dates}`)

    return NextResponse.json({
      message:      `Snapshotted ${snapshotted} props for ${dates}`,
      snapshotted,
      dates,
      ...(errors.length > 0 && { errors }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[/api/props/snapshot]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
