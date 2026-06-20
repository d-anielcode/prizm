// League-parameterized props fetch/cache. /api/props (NBA) and /api/props/wnba
// both call handlePropsRequest with their league config — one implementation.
import { NextResponse } from 'next/server'
import { supabase, isCacheStale, safeQuery } from '@/lib/supabase'
import { fetchTodaysNBAEvents, fetchTodaysWNBAEvents, fetchAllPropsForEvents, type NBAEvent } from '@/lib/odds-api'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'
import { deduplicatePropsWithAlts } from '@/lib/dedup'
import type { Prop } from '@/types'

export interface LeaguePropConfig {
  league: 'nba' | 'wnba'
  fetchEvents: () => Promise<NBAEvent[]>
  propsTable: string
  altsTable: string
  historyTable: string
}

export const LEAGUE_PROP_CONFIGS: Record<'nba' | 'wnba', LeaguePropConfig> = {
  nba:  { league: 'nba',  fetchEvents: fetchTodaysNBAEvents,  propsTable: 'props',      altsTable: 'prop_alts',      historyTable: 'prop_history' },
  wnba: { league: 'wnba', fetchEvents: fetchTodaysWNBAEvents, propsTable: 'wnba_props', altsTable: 'wnba_prop_alts', historyTable: 'wnba_prop_history' },
}

function allGamesStarted(props: Prop[]): boolean {
  const withTime = props.filter((p) => p.commence_time)
  if (withTime.length === 0) return false
  const now = Date.now()
  const gameStartTimes = new Map<string, number>()
  for (const p of withTime) {
    if (!gameStartTimes.has(p.game_id)) {
      gameStartTimes.set(p.game_id, new Date(p.commence_time!).getTime())
    }
  }
  return [...gameStartTimes.values()].every((t) => t < now)
}

async function fetchAndCacheFreshProps(cfg: LeaguePropConfig): Promise<Prop[]> {
  const events = await cfg.fetchEvents()
  if (!events || events.length === 0) return []

  const allProps = await fetchAllPropsForEvents(events)
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]))
  for (const prop of allProps) {
    const event = eventMap[prop.game_id]
    if (event) {
      prop.opponent = event.away_team === prop.team ? event.home_team : event.away_team
    }
  }

  const seen = new Set<string>()
  const deduped = allProps.filter((p) => {
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}|${p.sportsbook}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (deduped.length > 0) {
    const dedupedWithAlts = deduplicatePropsWithAlts(deduped)
    const mainProps = dedupedWithAlts.map(({ altLines: _alts, ...p }) => p)
    const now = new Date().toISOString()

    const existing = await safeQuery(
      supabase.from(cfg.propsTable).select('*').not('confidence_label', 'is', null),
      'snapshot existing enriched props'
    )
    if (existing.length > 0) {
      const fallbackDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
      const historyRows = existing.map((p: Record<string, unknown>) => {
        const gameDate = p.commence_time
          ? new Date(p.commence_time as string).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
          : fallbackDate
        return { ...p, game_date: gameDate }
      })
      const HBATCH = 500
      for (let i = 0; i < historyRows.length; i += HBATCH) {
        await supabase.from(cfg.historyTable).upsert(historyRows.slice(i, i + HBATCH), { onConflict: 'id,game_date' })
      }
      const dates = [...new Set(historyRows.map((r) => r.game_date))].join(', ')
      console.log(`[/api/props ${cfg.league}] Snapshotted ${existing.length} props to ${cfg.historyTable} for ${dates}`)
    }

    const prevLines = await safeQuery(
      supabase.from(cfg.propsTable).select('player_name, stat_type, direction, line, opening_line'),
      'load prev opening lines'
    )
    const openingLineMap = new Map<string, number>()
    for (const row of prevLines) {
      const key = `${row.player_name}|${row.stat_type}|${row.direction}`
      openingLineMap.set(key, Number((row as Record<string, unknown>).opening_line ?? row.line))
    }

    const BATCH = 500
    const propsWithOpening = mainProps.map((p) => {
      const key = `${p.player_name}|${p.stat_type}|${p.direction}`
      return { ...p, opening_line: openingLineMap.get(key) ?? p.line, cached_at: now }
    })
    for (let i = 0; i < propsWithOpening.length; i += BATCH) {
      const { error } = await supabase.from(cfg.propsTable).upsert(propsWithOpening.slice(i, i + BATCH), { onConflict: 'player_name,stat_type,line,direction,sportsbook' })
      if (error) console.error(`[/api/props ${cfg.league}] props upsert error:`, error.message)
    }
    const { error: sweepErr } = await supabase.from(cfg.propsTable).delete().lt('cached_at', now)
    if (sweepErr) logger.warn(`[/api/props ${cfg.league}] sweep old props failed`, { error: sweepErr.message })

    const STEP: Record<string, number> = {
      points: 2, pra: 2, rebounds: 1, assists: 1, steals: 1, blocks: 1, three_pointers: 1,
    }
    const allAltRows = mainProps.flatMap((p) => {
      const step = STEP[p.stat_type] ?? 1
      return [-1, 1]
        .map((n) => Math.round((p.line + n * step) * 2) / 2)
        .filter((altLine) => altLine >= 0.5)
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
    for (let i = 0; i < allAltRows.length; i += BATCH) {
      const { error } = await supabase.from(cfg.altsTable).upsert(allAltRows.slice(i, i + BATCH), { onConflict: 'player_name,stat_type,line,direction' })
      if (error) console.error(`[/api/props ${cfg.league}] prop_alts upsert error:`, error.message)
    }
    const { error: altSweepErr } = await supabase.from(cfg.altsTable).delete().lt('cached_at', now)
    if (altSweepErr) logger.warn(`[/api/props ${cfg.league}] sweep old alt lines failed`, { error: altSweepErr.message })

    console.log(`[/api/props ${cfg.league}] Refreshed — ${mainProps.length} main props + ${allAltRows.length} alt lines for ${events.length} games`)
  } else {
    console.log(`[/api/props ${cfg.league}] Refreshed — 0 props for ${events.length} games`)
  }
  const times = [...new Set(deduped.map((p) => p.commence_time).filter(Boolean))].sort()
  if (times.length > 0) console.log(`[/api/props ${cfg.league}] Games tip off at: ${times.join(', ')}`)

  return deduped
}

export async function handlePropsRequest(req: Request, cfg: LeaguePropConfig) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const forceRefresh = new URL(req.url).searchParams.get('refresh') === 'true'

    const { data: cached, error: cacheError } = await supabase
      .from(cfg.propsTable)
      .select('*')
      .order('confidence_score', { ascending: false, nullsFirst: false })

    const cachedProps = (cached ?? []) as Prop[]

    const shouldRefresh =
      forceRefresh ||
      cacheError != null ||
      cachedProps.length === 0 ||
      isCacheStale(cachedProps[0]?.cached_at ?? '') ||
      allGamesStarted(cachedProps)

    if (!shouldRefresh) {
      const reason = allGamesStarted(cachedProps) ? 'games_started' : 'cached'
      return NextResponse.json({ props: cachedProps, cached: true, count: cachedProps.length, reason })
    }

    const freshProps = await fetchAndCacheFreshProps(cfg)

    if (freshProps.length === 0) {
      return NextResponse.json({
        props: cachedProps, cached: true, count: cachedProps.length,
        message: 'No upcoming games found — showing last cached props',
      })
    }

    return NextResponse.json({ props: freshProps, cached: false, count: freshProps.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[/api/props ${cfg.league}] Error:`, message)
    return NextResponse.json({ error: 'Failed to fetch props', details: message }, { status: 500 })
  }
}
