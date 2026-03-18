// /api/enrich — Enriches all cached props with confidence scores
// Runs after /api/props has populated the cache.
// Fetches stats per unique player from BallDontLie, scores each prop,
// updates Supabase with confidence_score, confidence_label, risk_tier, confidence_reason

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { searchPlayer, fetchPlayerRecentStats, fetchSeasonAverages, parseBDLStats } from '@/lib/nba-api'
import { scoreProps } from '@/lib/confidence'
import type { Prop, PlayerStat, StatType } from '@/types'

// Rate limit: pause between BallDontLie requests to stay under 60 req/min
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function POST() {
  try {
    // Debug: confirm which key is loaded
    const keyUsed = process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'
    console.log('[/api/enrich] Supabase key in use:', keyUsed)

    // 1. Load all props from Supabase
    const { data: props, error } = await supabase
      .from('props')
      .select('*')
      .is('confidence_score', null)

    if (error) throw new Error(`Supabase read error: ${error.message}`)
    if (!props || props.length === 0) {
      return NextResponse.json({ message: 'No props to enrich', enriched: 0 })
    }

    // 2. Get unique player names
    const uniqueNames = [...new Set((props as Prop[]).map((p) => p.player_name))]
    const statsMap = new Map<string, PlayerStat[]>()
    const seasonMap = new Map<string, Record<StatType, number> | null>()

    // 3. Fetch stats for each unique player
    for (const name of uniqueNames) {
      try {
        const player = await searchPlayer(name)
        await sleep(1100) // Stay under 60 req/min

        if (!player) {
          statsMap.set(name, [])
          seasonMap.set(name, null)
          continue
        }

        const [recentEntries, seasonAvg] = await Promise.all([
          fetchPlayerRecentStats(player.id, 10),
          fetchSeasonAverages(player.id),
        ])
        await sleep(1100)

        const stats = parseBDLStats(recentEntries)
        statsMap.set(name, stats)

        if (seasonAvg) {
          seasonMap.set(name, {
            points: seasonAvg.pts,
            rebounds: seasonAvg.reb,
            assists: seasonAvg.ast,
            steals: seasonAvg.stl,
            blocks: seasonAvg.blk,
            three_pointers: seasonAvg.fg3m,
            pra: seasonAvg.pts + seasonAvg.reb + seasonAvg.ast,
          })
        } else {
          seasonMap.set(name, null)
        }
      } catch {
        console.warn(`[/api/enrich] Skipped ${name}`)
        statsMap.set(name, [])
        seasonMap.set(name, null)
      }
    }

    // 4. Score each prop and batch-update Supabase
    let enriched = 0
    for (const prop of props as Prop[]) {
      const recentStats = statsMap.get(prop.player_name) ?? []
      const seasonAvg = seasonMap.get(prop.player_name) ?? null

      // Estimate days since last game from stats
      const daysSinceLastGame = recentStats.length > 0
        ? Math.round((Date.now() - new Date(recentStats[0].game_date).getTime()) / 86400000)
        : 1

      const scored = scoreProps(
        prop,
        recentStats,
        seasonAvg,
        15, // default neutral opp rank (no live defense rank data on free tier)
        true, // default home (simplified)
        daysSinceLastGame
      )

      const { error: updateError } = await supabase
        .from('props')
        .update({
          confidence_score: scored.confidence_score,
          confidence_label: scored.confidence_label,
          risk_tier: scored.risk_tier,
          confidence_reason: scored.confidence_reason,
        })
        .eq('id', prop.id)

      if (!updateError) enriched++
    }

    return NextResponse.json({
      message: `Enriched ${enriched} props with confidence scores`,
      enriched,
      total: props.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json(
      { error: 'Enrichment failed', details: message },
      { status: 500 }
    )
  }
}

// Also allow GET for browser testing
export async function GET() {
  return NextResponse.json({
    message: 'Send a POST request to /api/enrich to score all cached props',
    hint: 'Run: fetch("/api/enrich", { method: "POST" }) in the browser console',
  })
}
