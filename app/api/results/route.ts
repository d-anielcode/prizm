// /api/results — Calculate & store prop hit rates from completed games
//
// POST (or GET?force=true): Reads all current props + recent game logs,
//   calculates how many hit for each confidence tier, and upserts to prop_results.
//   Call this BEFORE refreshing props each day so old props are still in the DB.
//
// GET: Returns the last 14 days of stored results for display.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import type { Prop, StatType } from '@/types'

function getStatValue(log: Record<string, number>, statType: StatType): number {
  switch (statType) {
    case 'points':         return log.points ?? 0
    case 'rebounds':       return log.rebounds ?? 0
    case 'assists':        return log.assists ?? 0
    case 'steals':         return log.steals ?? 0
    case 'blocks':         return log.blocks ?? 0
    case 'three_pointers': return log.fg3m ?? 0
    case 'pra':            return log.pra ?? 0
    default:               return 0
  }
}

// Convert UTC commence_time → Eastern date string (YYYY-MM-DD)
function toEasternDate(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) // en-CA gives YYYY-MM-DD
}

async function calculateResults(forDate?: string) {
  // 1. Load props — from prop_history if a specific date is requested,
  //    otherwise from the live props table (called before nightly swap).
  let propsRaw: Prop[] | null = null
  let propsError: { message: string } | null = null

  if (forDate) {
    // Try prop_history table first (saved snapshots)
    const { data, error } = await supabase
      .from('prop_history')
      .select('player_name, stat_type, line, direction, confidence_label, confidence_score, commence_time')
      .eq('game_date', forDate)
      .not('confidence_label', 'is', null)
    propsRaw = (data ?? []) as Prop[]
    propsError = error
  } else {
    const { data, error } = await supabase
      .from('props')
      .select('player_name, stat_type, line, direction, confidence_label, confidence_score, commence_time')
      .not('confidence_label', 'is', null)
    propsRaw = (data ?? []) as Prop[]
    propsError = error
  }

  if (propsError || !propsRaw || propsRaw.length === 0) {
    return { message: 'No scored props found to evaluate', evaluated: 0 }
  }

  const props = propsRaw as Prop[]

  // Group by game date so we only evaluate props for games that have completed
  const dateGroups = new Map<string, Prop[]>()
  for (const prop of props) {
    if (!prop.commence_time) continue
    const gameDate = toEasternDate(prop.commence_time)
    if (!dateGroups.has(gameDate)) dateGroups.set(gameDate, [])
    dateGroups.get(gameDate)!.push(prop)
  }

  if (dateGroups.size === 0) {
    return { message: 'No props with commence_time found', evaluated: 0 }
  }

  // 2. Load relevant game logs — filter by the specific dates we care about
  //    (avoids loading full-season history and hitting the 1000-row Supabase limit)
  const playerNames = [...new Set(props.map((p) => p.player_name))]
  const gameDates   = [...dateGroups.keys()]
  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
    .in('player_name', playerNames)
    .in('game_date', gameDates)
    .order('game_date', { ascending: false })

  // Index logs by player_name + game_date
  const logIndex = new Map<string, Record<string, number>>()
  for (const log of logsRaw ?? []) {
    const key = `${log.player_name}|${log.game_date}`
    logIndex.set(key, log as Record<string, number>)
  }

  const rowsToUpsert: Array<{
    date: string
    confidence_label: string
    total: number
    hits: number
    hit_rate: number
  }> = []

  let totalEvaluated = 0

  for (const [gameDate, dateProps] of dateGroups) {
    // Deduplicate by player+stat (same as home page dedup — keep highest confidence)
    const best = new Map<string, Prop>()
    for (const p of dateProps) {
      const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`
      const ex = best.get(key)
      if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) best.set(key, p)
    }
    const dedupedProps = [...best.values()]

    // Tally hits per confidence tier
    const tiers: Record<string, { total: number; hits: number }> = {
      LOCK: { total: 0, hits: 0 },
      PLAY: { total: 0, hits: 0 },
      LEAN: { total: 0, hits: 0 },
      FADE: { total: 0, hits: 0 },
    }

    for (const prop of dedupedProps) {
      const label = prop.confidence_label as string
      if (!tiers[label]) continue

      const logKey = `${prop.player_name}|${gameDate}`
      const log = logIndex.get(logKey)
      if (!log) continue  // no game log for this player on this date = skip

      // Skip if player didn't really play (< 5 minutes)
      const minutes = Number(log.minutes ?? 0)
      if (minutes < 5) continue

      const actual = getStatValue(log, prop.stat_type as StatType)
      const hit =
        prop.direction === 'over'
          ? actual > prop.line
          : actual < prop.line

      tiers[label].total++
      if (hit) tiers[label].hits++
      totalEvaluated++
    }

    // Build aggregate rows for this date
    let allTotal = 0
    let allHits  = 0

    for (const [label, counts] of Object.entries(tiers)) {
      if (counts.total === 0) continue
      allTotal += counts.total
      allHits  += counts.hits
      rowsToUpsert.push({
        date:             gameDate,
        confidence_label: label,
        total:            counts.total,
        hits:             counts.hits,
        hit_rate:         Math.round((counts.hits / counts.total) * 10000) / 10000,
      })
    }

    if (allTotal > 0) {
      rowsToUpsert.push({
        date:             gameDate,
        confidence_label: 'ALL',
        total:            allTotal,
        hits:             allHits,
        hit_rate:         Math.round((allHits / allTotal) * 10000) / 10000,
      })
    }
  }

  if (rowsToUpsert.length === 0) {
    return {
      message: 'No matching game logs found — game logs may not yet be updated for these dates',
      evaluated: 0,
      dates: [...dateGroups.keys()],
    }
  }

  // 3. Upsert to prop_results
  const { error: upsertError } = await supabase
    .from('prop_results')
    .upsert(rowsToUpsert, { onConflict: 'date,confidence_label' })

  if (upsertError) {
    console.error('[/api/results] Upsert error:', upsertError.message)
    return { error: upsertError.message, evaluated: totalEvaluated }
  }

  return {
    message: `Evaluated ${totalEvaluated} props across ${dateGroups.size} date(s)`,
    evaluated: totalEvaluated,
    dates: [...dateGroups.keys()],
    rows: rowsToUpsert,
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url)

  // ?force=true → recalculate. Optional ?date=YYYY-MM-DD to grade a specific date.
  if (url.searchParams.get('force') === 'true') {
    try {
      const forDate = url.searchParams.get('date') ?? undefined
      const result = await calculateResults(forDate)
      return NextResponse.json(result)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      return NextResponse.json({ error: msg }, { status: 500 })
    }
  }

  // Default: return stored history (last 14 days)
  const { data, error } = await supabase
    .from('prop_results')
    .select('*')
    .order('date', { ascending: false })
    .limit(70) // 14 days × 5 labels (LOCK/PLAY/LEAN/FADE/ALL)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ results: data ?? [] })
}

export async function POST() {
  try {
    const result = await calculateResults()
    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
