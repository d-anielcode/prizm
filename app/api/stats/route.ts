// /api/stats?player_id=123 — Fetches player stats from BallDontLie, caches in Supabase
// Also supports ?player_name=Luka+Doncic for name-based lookup

import { NextRequest, NextResponse } from 'next/server'
import { supabase, isCacheStale } from '@/lib/supabase'
import { searchPlayer, fetchPlayerRecentStats, fetchSeasonAverages, parseBDLStats } from '@/lib/nba-api'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const playerIdParam = searchParams.get('player_id')
    const playerName = searchParams.get('player_name')

    if (!playerIdParam && !playerName) {
      return NextResponse.json(
        { error: 'Provide player_id or player_name query param' },
        { status: 400 }
      )
    }

    let playerId: number | null = playerIdParam ? parseInt(playerIdParam, 10) : null

    // Resolve name to ID if needed
    if (!playerId && playerName) {
      const player = await searchPlayer(playerName)
      if (!player) {
        return NextResponse.json({ error: `Player not found: ${playerName}` }, { status: 404 })
      }
      playerId = player.id
    }

    if (!playerId) {
      return NextResponse.json({ error: 'Could not resolve player ID' }, { status: 400 })
    }

    // Check Supabase cache
    const { data: cached } = await supabase
      .from('player_stats')
      .select('*')
      .eq('player_id', playerId)
      .order('game_date', { ascending: false })
      .limit(10)

    if (cached && cached.length > 0) {
      const newest = cached[0] as { cached_at: string }
      if (!isCacheStale(newest.cached_at)) {
        return NextResponse.json({ stats: cached, cached: true })
      }
    }

    // Fetch fresh stats
    const [recentEntries, seasonAvg] = await Promise.all([
      fetchPlayerRecentStats(playerId, 10),
      fetchSeasonAverages(playerId),
    ])

    const stats = parseBDLStats(recentEntries)

    // Cache in Supabase
    if (stats.length > 0) {
      await supabase
        .from('player_stats')
        .delete()
        .eq('player_id', playerId)

      await supabase.from('player_stats').insert(stats)
    }

    return NextResponse.json({ stats, season_averages: seasonAvg, cached: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/stats] Error:', message)
    return NextResponse.json(
      { error: 'Failed to fetch stats', details: message },
      { status: 500 }
    )
  }
}
