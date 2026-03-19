// /api/enrich — Enriches all cached props with confidence scores
// Runs after /api/props has populated the cache.
// Scores each prop using available data; falls back to neutral defaults if NBA stats are unavailable.
// GET is used by Vercel cron; POST also supported.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { resolvePlayerIds, fetchSeasonAveragesBatch, buildSeasonAvgMap } from '@/lib/nba-api'
import { scoreProps } from '@/lib/confidence'
import type { Prop, StatType } from '@/types'

async function runEnrichment(force = false) {
  const keyUsed = process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'
  console.log('[/api/enrich] Supabase key in use:', keyUsed, force ? '(force re-score)' : '')

  // If force mode, clear all existing scores so we re-score with the latest engine
  if (force) {
    await supabase.from('props').update({
      confidence_score: null,
      confidence_label: null,
      risk_tier: null,
      confidence_reason: null,
    }).not('id', 'is', null)
  }

  // 1. Load all unscored props from Supabase (max 500 per run — we only surface top 500)
  const { data: props, error } = await supabase
    .from('props')
    .select('*')
    .is('confidence_score', null)
    .limit(500)

  if (error) throw new Error(`Supabase read error: ${error.message}`)
  if (!props || props.length === 0) {
    return { message: 'No props to enrich', enriched: 0, total: 0 }
  }

  // 2. Fetch season averages for all unique players via BallDontLie (free tier)
  //    Step A: Resolve name → BDL id (sequential, 150ms gap, uses in-memory cache)
  //    Step B: ONE batch request for all season averages
  const uniqueNames = [...new Set((props as Prop[]).map((p) => p.player_name))]
  const seasonMap = new Map<string, Record<StatType, number> | null>()

  console.log(`[/api/enrich] Resolving ${uniqueNames.length} player IDs via BDL...`)
  const nameToId = await resolvePlayerIds(uniqueNames)
  console.log(`[/api/enrich] Found ${nameToId.size}/${uniqueNames.length} player IDs`)

  // Step B: batch season averages — just ONE request for all players
  const allIds = [...nameToId.values()]
  const avgById = await fetchSeasonAveragesBatch(allIds)
  console.log(`[/api/enrich] Season averages returned for ${avgById.size}/${allIds.length} players`)

  // Build name → season avg map
  for (const [name, id] of nameToId) {
    const avg = avgById.get(id)
    seasonMap.set(name, avg ? buildSeasonAvgMap(avg) : null)
  }

  const withData = [...seasonMap.values()].filter(Boolean).length
  console.log(`[/api/enrich] Season data found for ${withData}/${uniqueNames.length} players`)

  // 3. Score every prop (empty recentStats — v3 engine doesn't need game logs)
  const updates = (props as Prop[]).map((prop) => {
    const seasonAvg = seasonMap.get(prop.player_name) ?? null
    return scoreProps(prop, [], seasonAvg)
  })

  // 4. Batch-upsert scores to Supabase (500 at a time)
  // Send full prop objects so upsert never tries to INSERT with null required fields
  let enriched = 0
  const BATCH = 500
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
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

// GET — called by Vercel cron (and usable in browser); pass ?force=true to re-score all
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}

// POST — for manual triggers; pass ?force=true to re-score all
export async function POST(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}
