// /api/grade — Grades past props against actual game results
// Reads from prop_history + player_game_logs, writes hit/miss to prop_grades.
// Run nightly after games complete (e.g., 3 AM ET via cron).

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { StatType } from '@/types'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'

export const maxDuration = 120

// Explicit service-role client — bypasses RLS unconditionally
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('Missing SUPABASE env vars')
  return createClient(url, key, { auth: { persistSession: false } })
}

function getStatValue(row: Record<string, unknown>, statType: StatType): number | null {
  switch (statType) {
    case 'points':         return row.points   != null ? Number(row.points)   : null
    case 'rebounds':       return row.rebounds != null ? Number(row.rebounds) : null
    case 'assists':        return row.assists  != null ? Number(row.assists)  : null
    case 'steals':         return row.steals   != null ? Number(row.steals)   : null
    case 'blocks':         return row.blocks   != null ? Number(row.blocks)   : null
    case 'three_pointers': return row.fg3m     != null ? Number(row.fg3m)     : null
    case 'pra':            return row.pra      != null ? Number(row.pra)      : null
    default:               return null
  }
}

export async function POST(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const db = getServiceClient()
    const { searchParams } = new URL(req.url)

    // Optional: grade a specific date; defaults to yesterday ET
    const dateParam = searchParams.get('date')
    const gradeDate = dateParam ?? (() => {
      const d = new Date(Date.now() - 86400000)
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    })()

    console.log(`[/api/grade] Grading props for ${gradeDate}`)

    // 1. Load prop_history for this date
    const { data: histRows, error: histErr } = await db
      .from('prop_history')
      .select('player_name, stat_type, line, direction, confidence_label, confidence_score, game_date')
      .eq('game_date', gradeDate)
      .not('confidence_label', 'is', null)

    if (histErr) throw new Error(`prop_history read: ${histErr.message}`)
    if (!histRows || histRows.length === 0) {
      return NextResponse.json({ message: `No prop_history rows for ${gradeDate}`, graded: 0 })
    }
    console.log(`[/api/grade] Found ${histRows.length} historical props for ${gradeDate}`)

    // 2. Load game logs for all players on this date
    const playerNames = [...new Set(histRows.map((r) => r.player_name as string))]
    const { data: logRows, error: logErr } = await db
      .from('player_game_logs')
      .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
      .in('player_name', playerNames)
      .eq('game_date', gradeDate)

    if (logErr) throw new Error(`player_game_logs read: ${logErr.message}`)

    // Index logs by player_name for O(1) lookup
    const logByPlayer = new Map<string, Record<string, unknown>>()
    for (const row of logRows ?? []) {
      logByPlayer.set(row.player_name as string, row as Record<string, unknown>)
    }
    console.log(`[/api/grade] Game logs found for ${logByPlayer.size}/${playerNames.length} players`)

    // 3. Grade each prop
    const grades: Record<string, unknown>[] = []
    let matched = 0
    let dnp = 0

    for (const hist of histRows) {
      const log = logByPlayer.get(hist.player_name as string)
      const minutes = log ? Number(log.minutes ?? 0) : 0

      if (!log || minutes < 5) {
        // DNP or no log found — record as null hit
        grades.push({
          game_date:        hist.game_date,
          player_name:      hist.player_name,
          stat_type:        hist.stat_type,
          line:             hist.line,
          direction:        hist.direction,
          confidence_label: hist.confidence_label,
          confidence_score: hist.confidence_score,
          actual_value:     null,
          hit:              null,
        })
        dnp++
        continue
      }

      const actual = getStatValue(log, hist.stat_type as StatType)
      if (actual == null) continue

      const hit = hist.direction === 'over' ? actual > (hist.line as number) : actual < (hist.line as number)
      grades.push({
        game_date:        hist.game_date,
        player_name:      hist.player_name,
        stat_type:        hist.stat_type,
        line:             hist.line,
        direction:        hist.direction,
        confidence_label: hist.confidence_label,
        confidence_score: hist.confidence_score,
        actual_value:     actual,
        hit,
      })
      matched++
    }

    // 4. Dedup grades before upserting — prop_history may have duplicate rows for the same
    //    (game_date, player_name, stat_type, line, direction) key. Postgres throws
    //    "ON CONFLICT DO UPDATE command cannot affect row a second time" if duplicates
    //    exist within the same batch, so we keep only the first occurrence per key.
    const dedupMap = new Map<string, Record<string, unknown>>()
    for (const g of grades) {
      const key = `${g.game_date}|${g.player_name}|${g.stat_type}|${g.line}|${g.direction}`
      if (!dedupMap.has(key)) dedupMap.set(key, g)
    }
    const dedupedGrades = [...dedupMap.values()]
    console.log(`[/api/grade] After dedup: ${dedupedGrades.length} rows (removed ${grades.length - dedupedGrades.length} duplicates)`)

    const BATCH = 500
    let upserted = 0
    for (let i = 0; i < dedupedGrades.length; i += BATCH) {
      const { error } = await db
        .from('prop_grades')
        .upsert(dedupedGrades.slice(i, i + BATCH), { onConflict: 'game_date,player_name,stat_type,line,direction' })
      if (error) console.error(`[/api/grade] upsert error:`, error.message)
      else upserted += dedupedGrades.slice(i, i + BATCH).length
    }

    console.log(`[/api/grade] Done — ${matched} graded, ${dnp} DNP, ${upserted} upserted (${dedupedGrades.length} unique rows)`)
    return NextResponse.json({ gradeDate, graded: matched, dnp, upserted })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/grade] Error:', message)
    return NextResponse.json({ error: 'Grading failed', details: message }, { status: 500 })
  }
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError
  return POST(req)
}
