// /api/props — Fetches today's NBA props from The Odds API, caches in Supabase
// Returns: { props: Prop[], cached: boolean, count: number }

import { NextResponse } from 'next/server'
import { supabase, isCacheStale } from '@/lib/supabase'
import { fetchTodaysNBAEvents, fetchAllPropsForEvents } from '@/lib/odds-api'
import type { Prop } from '@/types'

export async function GET() {
  try {
    // 1. Check Supabase cache first
    const { data: cached, error: cacheError } = await supabase
      .from('props')
      .select('*')
      .order('cached_at', { ascending: false })
      .limit(1)

    if (!cacheError && cached && cached.length > 0) {
      const lastCached = cached[0] as { cached_at: string }
      if (!isCacheStale(lastCached.cached_at)) {
        // Serve from cache
        const { data: allProps } = await supabase
          .from('props')
          .select('*')
          .order('confidence_score', { ascending: false, nullsFirst: false })

        return NextResponse.json({
          props: allProps ?? [],
          cached: true,
          count: allProps?.length ?? 0,
        })
      }
    }

    // 2. Cache is stale or empty — fetch fresh from The Odds API
    const events = await fetchTodaysNBAEvents()

    if (!events || events.length === 0) {
      return NextResponse.json({
        props: [],
        cached: false,
        count: 0,
        message: 'No NBA games today',
      })
    }

    // 3. Fetch all props in batches of 10 (uses /odds/multi — ceil(N/10) requests)
    const allProps: Prop[] = await fetchAllPropsForEvents(events)

    // Attach opponent info from events map
    const eventMap = Object.fromEntries(events.map((e) => [e.id, e]))
    for (const prop of allProps) {
      const event = eventMap[prop.game_id]
      if (event) prop.opponent = event.away_team === prop.team ? event.home_team : event.away_team
    }

    // 4. Deduplicate by (player_name + stat_type + line + direction)
    const seen = new Set<string>()
    const deduped = allProps.filter((p) => {
      const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // 5. Upsert to Supabase in batches of 500 (clear old, insert new)
    if (deduped.length > 0) {
      await supabase.from('props').delete().neq('id', '00000000-0000-0000-0000-000000000000')

      const rows = deduped.map((p) => ({ ...p, cached_at: new Date().toISOString() }))
      const BATCH = 500
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error: insertError } = await supabase.from('props').insert(rows.slice(i, i + BATCH))
        if (insertError) {
          console.error(`[/api/props] Supabase insert error (batch ${i / BATCH + 1}):`, insertError.message)
        }
      }
    }

    return NextResponse.json({
      props: deduped,
      cached: false,
      count: deduped.length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/props] Error:', message)
    return NextResponse.json(
      { error: 'Failed to fetch props', details: message },
      { status: 500 }
    )
  }
}
