// /api/props — Fetches NBA player props, caches in Supabase
// Auto-switches to next day when all current games have started.
// Tip-off times are stored per-prop as commence_time (ISO string).

import { NextResponse } from 'next/server'
import { supabase, isCacheStale } from '@/lib/supabase'
import { fetchTodaysNBAEvents, fetchAllPropsForEvents } from '@/lib/odds-api'
import type { Prop } from '@/types'

// Returns true when all stored games have already tipped off — time to switch days
function allGamesStarted(props: Prop[]): boolean {
  const withTime = props.filter((p) => p.commence_time)
  if (withTime.length === 0) return false // no time data — don't force refresh

  const now = Date.now()
  // Group by game_id and check if every unique game has started
  const gameStartTimes = new Map<string, number>()
  for (const p of withTime) {
    if (!gameStartTimes.has(p.game_id)) {
      gameStartTimes.set(p.game_id, new Date(p.commence_time!).getTime())
    }
  }

  // All games tipped off = safe to switch to next day
  return [...gameStartTimes.values()].every((t) => t < now)
}

async function fetchAndCacheFreshProps(): Promise<Prop[]> {
  const events = await fetchTodaysNBAEvents()
  if (!events || events.length === 0) return []

  const allProps = await fetchAllPropsForEvents(events)

  // Attach opponent from event map
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]))
  for (const prop of allProps) {
    const event = eventMap[prop.game_id]
    if (event) {
      prop.opponent = event.away_team === prop.team ? event.home_team : event.away_team
    }
  }

  // Deduplicate by (player + stat + line + direction + sportsbook)
  const seen = new Set<string>()
  const deduped = allProps.filter((p) => {
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}|${p.sportsbook}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (deduped.length > 0) {
    // Clear old props, insert new batch
    await supabase.from('props').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    const rows = deduped.map((p) => ({ ...p, cached_at: new Date().toISOString() }))
    const BATCH = 500
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase.from('props').insert(rows.slice(i, i + BATCH))
      if (error) console.error(`[/api/props] insert error:`, error.message)
    }
  }

  console.log(`[/api/props] Refreshed — ${deduped.length} props for ${events.length} games`)
  // Log next game tip-offs for debugging
  const times = [...new Set(deduped.map((p) => p.commence_time).filter(Boolean))].sort()
  if (times.length > 0) console.log(`[/api/props] Games tip off at: ${times.join(', ')}`)

  return deduped
}

export async function GET(req: Request) {
  try {
    const forceRefresh = new URL(req.url).searchParams.get('refresh') === 'true'

    // 1. Load cached props
    const { data: cached, error: cacheError } = await supabase
      .from('props')
      .select('*')
      .order('confidence_score', { ascending: false, nullsFirst: false })

    const cachedProps = (cached ?? []) as Prop[]

    // 2. Decide whether to refresh
    const shouldRefresh =
      forceRefresh ||
      cacheError != null ||
      cachedProps.length === 0 ||
      isCacheStale(cachedProps[0]?.cached_at ?? '') ||
      allGamesStarted(cachedProps) // 👈 auto-switch to next day

    if (!shouldRefresh) {
      const reason = allGamesStarted(cachedProps) ? 'games_started' : 'cached'
      return NextResponse.json({
        props: cachedProps,
        cached: true,
        count: cachedProps.length,
        reason,
      })
    }

    // 3. Fetch fresh props (next pending games — could be today or tomorrow)
    const freshProps = await fetchAndCacheFreshProps()

    if (freshProps.length === 0) {
      // No pending games — return whatever we have (could be empty between seasons)
      return NextResponse.json({
        props: cachedProps,
        cached: true,
        count: cachedProps.length,
        message: 'No upcoming NBA games found — showing last cached props',
      })
    }

    return NextResponse.json({
      props: freshProps,
      cached: false,
      count: freshProps.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/props] Error:', message)
    return NextResponse.json({ error: 'Failed to fetch props', details: message }, { status: 500 })
  }
}
