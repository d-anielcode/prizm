// /api/prophistory/reenrich
//
// Re-scores existing prop_history rows with the current confidence model (v6.2)
// and writes updated labels back to prop_history, then auto-grades to prop_grades.
//
// No API credits needed — reads entirely from prop_history + player_game_logs.
//
// GET ?date=YYYY-MM-DD                    — single date
//     ?start=YYYY-MM-DD&end=YYYY-MM-DD   — date range
//     ?days=N                             — last N days (default 45)

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { scoreProps, type GameLog, type PlayerLineBias, type OpponentStatLeak, type ScoringContext } from '@/lib/confidence'
import type { Prop, StatType } from '@/types'

export const maxDuration = 120

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

function getStatValue(log: GameLog, statType: StatType): number | null {
  switch (statType) {
    case 'points':         return log.points   != null ? Number(log.points)   : null
    case 'rebounds':       return log.rebounds != null ? Number(log.rebounds) : null
    case 'assists':        return log.assists  != null ? Number(log.assists)  : null
    case 'steals':         return log.steals   != null ? Number(log.steals)   : null
    case 'blocks':         return log.blocks   != null ? Number(log.blocks)   : null
    case 'three_pointers': return log.fg3m     != null ? Number(log.fg3m)     : null
    case 'pra':            return log.pra      != null ? Number(log.pra)      : null
    default:               return null
  }
}

export async function GET(req: Request) {
  try {
    const db  = getServiceClient()
    const url = new URL(req.url)

    const dateParam  = url.searchParams.get('date')
    const startParam = url.searchParams.get('start')
    const endParam   = url.searchParams.get('end')
    const days       = parseInt(url.searchParams.get('days') ?? '45')

    const today  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const cutoff = dateParam ?? startParam ?? new Date(Date.now() - days * 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const end    = dateParam ?? endParam ?? today

    // ── 1. Load prop_history rows for the date range ──────────────────────────
    const propRows: Record<string, unknown>[] = []
    {
      let from = 0
      const PAGE = 1000
      while (true) {
        const { data: page, error } = await db
          .from('prop_history')
          .select('id, player_name, stat_type, direction, line, odds, commence_time, home_team, away_team, game_date')
          .eq('direction', 'over')
          .gte('game_date', cutoff)
          .lte('game_date', end)
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`prop_history read: ${error.message}`)
        if (!page || page.length === 0) break
        propRows.push(...(page as Record<string, unknown>[]))
        if (page.length < PAGE) break
        from += PAGE
      }
    }

    if (propRows.length === 0) {
      return NextResponse.json({ message: 'No prop_history rows found for date range', reenriched: 0 })
    }

    console.log(`[reenrich] Found ${propRows.length} prop_history rows for ${cutoff} → ${end}`)

    // ── 2. Load all game logs for relevant players ────────────────────────────
    const playerSet = [...new Set(propRows.map((r) => r.player_name as string))]
    const allLogs: GameLog[] = []
    {
      let from = 0
      const PAGE = 1000
      while (true) {
        const { data: page, error } = await db
          .from('player_game_logs')
          .select('player_name, game_date, matchup, is_home, points, rebounds, assists, pra, blocks, steals, fg3m, minutes')
          .in('player_name', playerSet)
          .order('game_date', { ascending: false })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`player_game_logs read: ${error.message}`)
        if (!page || page.length === 0) break
        allLogs.push(...(page as Record<string, unknown>[]))
        if (page.length < PAGE) break
        from += PAGE
      }
    }
    console.log(`[reenrich] Loaded ${allLogs.length} game log rows for ${playerSet.length} players`)

    // ── 3. Load bias + leak tables ────────────────────────────────────────────
    const { data: biasRows } = await db
      .from('player_line_bias')
      .select('player_name, stat_type, hit_rate, median_ratio, sample_count')
    const biasMap = new Map<string, PlayerLineBias>()
    for (const row of biasRows ?? []) {
      biasMap.set(`${row.player_name}|${row.stat_type}`, {
        hit_rate:     Number(row.hit_rate),
        median_ratio: Number(row.median_ratio),
        sample_count: Number(row.sample_count),
      })
    }

    const { data: leakRows } = await db
      .from('opponent_stat_leaks')
      .select('opponent_team, stat_type, over_hit_rate, median_ratio, sample_count')
    const leakMap = new Map<string, OpponentStatLeak>()
    for (const row of leakRows ?? []) {
      leakMap.set(`${row.opponent_team}|${row.stat_type}`, {
        over_hit_rate: Number(row.over_hit_rate),
        median_ratio:  Number(row.median_ratio),
        sample_count:  Number(row.sample_count),
      })
    }

    // Index logs
    const logsByPlayer = new Map<string, GameLog[]>()
    const logByPlayerDate = new Map<string, GameLog>()
    for (const log of allLogs) {
      const pn = log.player_name
      if (!logsByPlayer.has(pn)) logsByPlayer.set(pn, [])
      logsByPlayer.get(pn)!.push(log)
      logByPlayerDate.set(`${pn}|${log.game_date}`, log)
    }

    // ── 4. Re-score each prop with current model ──────────────────────────────
    const now = new Date().toISOString()
    const updatedHistory: Record<string, unknown>[] = []
    const gradedRows: Record<string, unknown>[] = []
    let skipped = 0

    for (const prop of propRows) {
      const gameDate  = prop.game_date as string
      const allPlayerLogs = logsByPlayer.get(prop.player_name as string) ?? []
      const priorLogs = allPlayerLogs.filter((g) => g.game_date < gameDate)
      if (priorLogs.length < 3) { skipped++; continue }

      const gameLog = logByPlayerDate.get(`${prop.player_name}|${gameDate}`)
      let opponentAbbr: string | null = null
      if (gameLog) {
        const parts = gameLog.matchup.split('@')
        if (parts.length === 2)
          opponentAbbr = gameLog.is_home ? parts[0].trim() : parts[1].trim()
      }

      const propObj: Prop = {
        id:            prop.id as string,
        player_id:     0,
        player_name:   prop.player_name as string,
        team:          '',
        opponent:      opponentAbbr ?? '',
        game_id:       '',
        stat_type:     prop.stat_type as StatType,
        direction:     'over',
        line:          Number(prop.line),
        odds:          prop.odds != null ? Number(prop.odds) : undefined,
        commence_time: (prop.commence_time as string) ?? `${gameDate}T23:30:00+00:00`,
      }

      const ctx: ScoringContext = {
        playerBias:   biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
        opponentLeak: opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
        opponentAbbr,
      }

      const scored = scoreProps(propObj, priorLogs, null, ctx)

      updatedHistory.push({
        id:                prop.id,
        player_name:       prop.player_name,
        stat_type:         prop.stat_type,
        direction:         'over',
        line:              prop.line,
        odds:              prop.odds ?? null,
        confidence_score:  scored.confidence_score,
        confidence_label:  scored.confidence_label,
        risk_tier:         scored.risk_tier,
        confidence_reason: scored.confidence_reason,
        commence_time:     prop.commence_time ?? null,
        home_team:         prop.home_team ?? null,
        away_team:         prop.away_team ?? null,
        game_id:           '',
        cached_at:         now,
        game_date:         gameDate,
      })

      // Also grade if game log exists
      if (gameLog) {
        const minutes = Number(gameLog.minutes ?? 0)
        if (minutes >= 5) {
          const actual = getStatValue(gameLog, prop.stat_type as StatType)
          if (actual !== null) {
            gradedRows.push({
              game_date:        gameDate,
              player_name:      prop.player_name,
              stat_type:        prop.stat_type,
              line:             prop.line,
              direction:        'over',
              confidence_label: scored.confidence_label,
              confidence_score: scored.confidence_score,
              actual_value:     actual,
              hit:              actual > Number(prop.line),
            })
          }
        }
      }
    }

    // Dedup prop_history by id+game_date before upserting
    const historyDedup = new Map<string, Record<string, unknown>>()
    for (const r of updatedHistory) {
      const key = `${r.id}|${r.game_date}`
      if (!historyDedup.has(key)) historyDedup.set(key, r)
    }
    const dedupedHistory = [...historyDedup.values()]

    console.log(`[reenrich] Re-scored ${updatedHistory.length} props (${skipped} skipped — < 3 prior logs), ${dedupedHistory.length} unique after dedup`)

    // ── 5. Upsert updated prop_history labels ─────────────────────────────────
    const BATCH = 500
    let reenriched = 0
    for (let i = 0; i < dedupedHistory.length; i += BATCH) {
      const { error } = await db
        .from('prop_history')
        .upsert(dedupedHistory.slice(i, i + BATCH), { onConflict: 'id,game_date' })
      if (error) console.error(`[reenrich] prop_history upsert error:`, error.message)
      else reenriched += dedupedHistory.slice(i, i + BATCH).length
    }

    // ── 6. Dedup and upsert prop_grades ───────────────────────────────────────
    const dedupMap = new Map<string, Record<string, unknown>>()
    for (const g of gradedRows) {
      const key = `${g.game_date}|${g.player_name}|${g.stat_type}|${g.line}|${g.direction}`
      if (!dedupMap.has(key)) dedupMap.set(key, g)
    }
    const dedupedGrades = [...dedupMap.values()]

    let graded = 0
    for (let i = 0; i < dedupedGrades.length; i += BATCH) {
      const { error } = await db
        .from('prop_grades')
        .upsert(dedupedGrades.slice(i, i + BATCH), { onConflict: 'game_date,player_name,stat_type,line,direction' })
      if (error) console.error(`[reenrich] prop_grades upsert error:`, error.message)
      else graded += dedupedGrades.slice(i, i + BATCH).length
    }

    const dates = [...new Set(updatedHistory.map((r) => r.game_date as string))].sort()
    console.log(`[reenrich] Done — ${reenriched} prop_history updated, ${graded} prop_grades upserted across ${dates.length} dates`)

    return NextResponse.json({ reenriched, graded, skipped, dates })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[reenrich] Error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
