// /api/props — Fetches NBA player props, caches in Supabase
// Auto-switches to next day when all current games have started.
// Tip-off times are stored per-prop as commence_time (ISO string).

import { NextResponse } from 'next/server'
import { supabase, isCacheStale } from '@/lib/supabase'
import { fetchTodaysNBAEvents, fetchAllPropsForEvents } from '@/lib/odds-api'

export const maxDuration = 120
import { deduplicatePropsWithAlts } from '@/lib/dedup'
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
    // Separate main lines from alt lines
    const dedupedWithAlts = deduplicatePropsWithAlts(deduped)
    const mainProps = dedupedWithAlts.map(({ altLines: _alts, ...p }) => p)
    const now = new Date().toISOString()
    const altRows = dedupedWithAlts.flatMap((p) =>
      (p.altLines ?? []).map((alt) => ({
        player_name:    p.player_name,
        stat_type:      p.stat_type,
        direction:      alt.direction,
        game_id:        p.game_id,
        line:           alt.line,
        odds:           alt.odds ?? null,
        sportsbook:     alt.sportsbook ?? null,
        home_team:      p.home_team ?? null,
        away_team:      p.away_team ?? null,
        commence_time:  p.commence_time ?? null,
        cached_at:      now,
      }))
    )

    // Snapshot existing main props to prop_history BEFORE deleting (for results grading)
    const { data: existing } = await supabase
      .from('props')
      .select('*')
      .not('confidence_label', 'is', null)
    if (existing && existing.length > 0) {
      const fallbackDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      const historyRows = existing.map((p: Record<string, unknown>) => {
        const gameDate = p.commence_time
          ? new Date(p.commence_time as string).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
          : fallbackDate
        return { ...p, game_date: gameDate }
      })
      const HBATCH = 500
      for (let i = 0; i < historyRows.length; i += HBATCH) {
        await supabase.from('prop_history').upsert(historyRows.slice(i, i + HBATCH), { onConflict: 'id,game_date' })
      }
      const dates = [...new Set(historyRows.map((r) => r.game_date))].join(', ')
      console.log(`[/api/props] Snapshotted ${existing.length} props to prop_history for ${dates}`)
    }

    // Snapshot opening lines before delete — carry forward so movement is visible
    const { data: prevLines } = await supabase
      .from('props')
      .select('player_name, stat_type, direction, line, opening_line')
    const openingLineMap = new Map<string, number>()
    for (const row of prevLines ?? []) {
      const key = `${row.player_name}|${row.stat_type}|${row.direction}`
      // COALESCE(opening_line, line) — keep original opening line if it exists
      openingLineMap.set(key, Number((row as Record<string, unknown>).opening_line ?? row.line))
    }

    // Clear and insert main props
    const BATCH = 500
    await supabase.from('props').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    const propsWithOpening = mainProps.map((p) => {
      const key = `${p.player_name}|${p.stat_type}|${p.direction}`
      return { ...p, opening_line: openingLineMap.get(key) ?? p.line }
    })
    for (let i = 0; i < propsWithOpening.length; i += BATCH) {
      const { error } = await supabase.from('props').insert(propsWithOpening.slice(i, i + BATCH))
      if (error) console.error(`[/api/props] props insert error:`, error.message)
    }

    // Generate synthetic alt lines: ±2 increments from each main line
    // Points/PRA use step=2; all other stats use step=1
    const STEP: Record<string, number> = {
      points: 2, pra: 2, rebounds: 1, assists: 1, steals: 1, blocks: 1, three_pointers: 1,
    }
    const realAltKeys = new Set(altRows.map((a) => `${a.player_name}|${a.stat_type}|${a.direction}|${a.line}`))
    const syntheticAltRows = mainProps.flatMap((p) => {
      const step = STEP[p.stat_type] ?? 1
      return [-2, -1, 1, 2]
        .map((n) => Math.round((p.line + n * step) * 2) / 2)
        .filter((altLine) => altLine >= 0.5)
        .filter((altLine) => !realAltKeys.has(`${p.player_name}|${p.stat_type}|${p.direction}|${altLine}`))
        .map((altLine) => ({
          player_name:   p.player_name,
          stat_type:     p.stat_type,
          direction:     p.direction,
          game_id:       p.game_id,
          line:          altLine,
          odds:          null,
          sportsbook:    null,
          home_team:     p.home_team ?? null,
          away_team:     p.away_team ?? null,
          commence_time: p.commence_time ?? null,
          cached_at:     now,
        }))
    })

    // Clear and insert alt lines (real sportsbook + synthetic)
    const allAltRows = [...altRows, ...syntheticAltRows]
    await supabase.from('prop_alts').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    for (let i = 0; i < allAltRows.length; i += BATCH) {
      const { error } = await supabase.from('prop_alts').insert(allAltRows.slice(i, i + BATCH))
      if (error) console.error(`[/api/props] prop_alts insert error:`, error.message)
    }

    console.log(`[/api/props] Refreshed — ${mainProps.length} main props + ${altRows.length} sportsbook alts + ${syntheticAltRows.length} synthetic alts for ${events.length} games`)
  } else {
    console.log(`[/api/props] Refreshed — 0 props for ${events.length} games`)
  }
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

    // Enrich runs via cron 15 min after props refresh — with full ESPN data.
    // Removed fire-and-forget here: it raced the cron, always had ESPN=0 games
    // (fired before ESPN scoreboard loaded), and caused prop_history deadlocks.

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
