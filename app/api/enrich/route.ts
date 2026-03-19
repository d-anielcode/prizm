// /api/enrich — Enriches all cached props with confidence scores
// Runs after /api/props has populated the cache.
// Scores each prop using available data; falls back to neutral defaults if NBA stats are unavailable.
// GET is used by Vercel cron; POST also supported.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { searchPlayer, fetchPlayerRecentStats, fetchSeasonAverages, parseBDLStats } from '@/lib/nba-api'
import { scoreProps } from '@/lib/confidence'
import type { Prop, PlayerStat, StatType } from '@/types'

async function runEnrichment() {
  const keyUsed = process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'
  console.log('[/api/enrich] Supabase key in use:', keyUsed)

  // 1. Load all unscored props from Supabase (max 1000 per run)
  const { data: props, error } = await supabase
    .from('props')
    .select('*')
    .is('confidence_score', null)
    .limit(1000)

  if (error) throw new Error(`Supabase read error: ${error.message}`)
  if (!props || props.length === 0) {
    return { message: 'No props to enrich', enriched: 0, total: 0 }
  }

  // 2. Try to fetch NBA stats for unique players (best-effort — skip if unavailable)
  const uniqueNames = [...new Set((props as Prop[]).map((p) => p.player_name))]
  const statsMap = new Map<string, PlayerStat[]>()
  const seasonMap = new Map<string, Record<StatType, number> | null>()

  // Attempt NBA stats with a tight timeout so we don't stall Vercel cron
  const NBA_TIMEOUT_MS = 5000
  for (const name of uniqueNames) {
    try {
      const playerPromise = searchPlayer(name)
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), NBA_TIMEOUT_MS))
      const player = await Promise.race([playerPromise, timeoutPromise])

      if (!player) {
        statsMap.set(name, [])
        seasonMap.set(name, null)
        continue
      }

      const [recentEntries, seasonAvg] = await Promise.all([
        fetchPlayerRecentStats(player.id, 10).catch(() => []),
        fetchSeasonAverages(player.id).catch(() => null),
      ])

      statsMap.set(name, parseBDLStats(recentEntries))
      seasonMap.set(name, seasonAvg ? {
        points: seasonAvg.pts,
        rebounds: seasonAvg.reb,
        assists: seasonAvg.ast,
        steals: seasonAvg.stl,
        blocks: seasonAvg.blk,
        three_pointers: seasonAvg.fg3m,
        pra: seasonAvg.pts + seasonAvg.reb + seasonAvg.ast,
      } : null)
    } catch {
      statsMap.set(name, [])
      seasonMap.set(name, null)
    }
  }

  // 3. Score every prop — use neutral defaults when no stats available
  const updates = (props as Prop[]).map((prop) => {
    const recentStats = statsMap.get(prop.player_name) ?? []
    const seasonAvg = seasonMap.get(prop.player_name) ?? null
    const daysSinceLastGame = recentStats.length > 0
      ? Math.round((Date.now() - new Date(recentStats[0].game_date).getTime()) / 86400000)
      : 1
    return scoreProps(prop, recentStats, seasonAvg, 15, true, daysSinceLastGame)
  })

  // 4. Batch-upsert scores to Supabase (500 at a time)
  let enriched = 0
  const BATCH = 500
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH).map((s) => ({
      id: s.id,
      confidence_score: s.confidence_score,
      confidence_label: s.confidence_label,
      risk_tier: s.risk_tier,
      confidence_reason: s.confidence_reason,
    }))
    const { error: upsertError } = await supabase
      .from('props')
      .upsert(batch, { onConflict: 'id' })
    if (!upsertError) enriched += batch.length
    else console.error('[/api/enrich] Upsert error:', upsertError.message)
  }

  return {
    message: `Enriched ${enriched} props with confidence scores`,
    enriched,
    total: props.length,
  }
}

// GET — called by Vercel cron (and usable in browser)
export async function GET() {
  try {
    const result = await runEnrichment()
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}

// POST — for manual triggers
export async function POST() {
  try {
    const result = await runEnrichment()
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}
