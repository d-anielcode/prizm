// League-parameterized prop grading. /api/grade (NBA) and /api/grade/wnba both
// call gradeLeague with their config — one implementation.
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { StatType } from '@/types'
import { requireCronAuth } from '@/lib/api-auth'

export interface GradeConfig {
  league: 'nba' | 'wnba'
  historyTable: string
  logsTable: string
  gradesTable: string
  requireLabel: boolean         // NBA grades only enriched props; WNBA grades all
  refreshPerfSnapshot?: boolean // NBA pre-warms the performance page after grading
}

export const GRADE_CONFIGS: Record<'nba' | 'wnba', GradeConfig> = {
  nba:  { league: 'nba',  historyTable: 'prop_history',      logsTable: 'player_game_logs',      gradesTable: 'prop_grades',      requireLabel: true,  refreshPerfSnapshot: true },
  wnba: { league: 'wnba', historyTable: 'wnba_prop_history', logsTable: 'wnba_player_game_logs', gradesTable: 'wnba_prop_grades', requireLabel: false },
}

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

/**
 * Pure grade of one prop against its game log.
 *  - no log OR minutes < 5  -> DNP: { actual_value: null, hit: null }
 *  - played but stat is null -> null (caller skips, no grade row)
 *  - otherwise -> { actual_value, hit }
 */
export function gradeProp(
  hist: Record<string, unknown>,
  log: Record<string, unknown> | undefined,
): { actual_value: number | null; hit: boolean | null } | null {
  const minutes = log ? Number(log.minutes ?? 0) : 0
  if (!log || minutes < 5) return { actual_value: null, hit: null }
  const actual = getStatValue(log, hist.stat_type as StatType)
  if (actual == null) return null
  const hit = hist.direction === 'over' ? actual > Number(hist.line) : actual < Number(hist.line)
  return { actual_value: actual, hit }
}

export async function gradeLeague(req: Request, cfg: GradeConfig) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  try {
    const db = getServiceClient()
    const { searchParams } = new URL(req.url)
    const dateParam = searchParams.get('date')
    const gradeDate = dateParam ?? (() => {
      const d = new Date(Date.now() - 86400000)
      return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    })()

    console.log(`[/api/grade ${cfg.league}] Grading props for ${gradeDate}`)

    let histSel = db.from(cfg.historyTable)
      .select('player_name, stat_type, line, direction, confidence_label, confidence_score, game_date')
      .eq('game_date', gradeDate)
    if (cfg.requireLabel) histSel = histSel.not('confidence_label', 'is', null)
    const { data: histRows, error: histErr } = await histSel
    if (histErr) throw new Error(`${cfg.historyTable} read: ${histErr.message}`)
    if (!histRows || histRows.length === 0) {
      return NextResponse.json({ message: `No ${cfg.historyTable} rows for ${gradeDate}`, graded: 0 })
    }

    const playerNames = [...new Set(histRows.map((r) => r.player_name as string))]
    const { data: logRows, error: logErr } = await db
      .from(cfg.logsTable)
      .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
      .in('player_name', playerNames)
      .eq('game_date', gradeDate)
    if (logErr) throw new Error(`${cfg.logsTable} read: ${logErr.message}`)

    const logByPlayer = new Map<string, Record<string, unknown>>()
    for (const row of logRows ?? []) logByPlayer.set(row.player_name as string, row as Record<string, unknown>)

    const grades: Record<string, unknown>[] = []
    let matched = 0, dnp = 0
    for (const hist of histRows) {
      const g = gradeProp(hist as Record<string, unknown>, logByPlayer.get(hist.player_name as string))
      if (g === null) continue
      grades.push({
        game_date: hist.game_date, player_name: hist.player_name, stat_type: hist.stat_type,
        line: hist.line, direction: hist.direction,
        confidence_label: hist.confidence_label, confidence_score: hist.confidence_score,
        actual_value: g.actual_value, hit: g.hit,
      })
      if (g.hit === null) dnp++; else matched++
    }

    const dedupMap = new Map<string, Record<string, unknown>>()
    for (const g of grades) {
      const key = `${g.game_date}|${g.player_name}|${g.stat_type}|${g.line}|${g.direction}`
      if (!dedupMap.has(key)) dedupMap.set(key, g)
    }
    const deduped = [...dedupMap.values()]

    const BATCH = 500
    let upserted = 0
    for (let i = 0; i < deduped.length; i += BATCH) {
      const { error } = await db.from(cfg.gradesTable)
        .upsert(deduped.slice(i, i + BATCH), { onConflict: 'game_date,player_name,stat_type,line,direction' })
      if (error) console.error(`[/api/grade ${cfg.league}] upsert error:`, error.message)
      else upserted += deduped.slice(i, i + BATCH).length
    }

    console.log(`[/api/grade ${cfg.league}] Done — ${matched} graded, ${dnp} DNP, ${upserted} upserted`)

    // NBA only: fire-and-forget refresh of the performance-page snapshot cache
    // (preserves the original /api/grade behavior; WNBA has no such page yet).
    if (cfg.refreshPerfSnapshot) {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
        ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
      fetch(`${baseUrl}/api/performance-snapshot`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
      }).catch(() => {})
    }

    return NextResponse.json({ gradeDate, league: cfg.league, graded: matched, dnp, upserted })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[/api/grade ${cfg.league}] Error:`, message)
    return NextResponse.json({ error: 'Grading failed', details: message }, { status: 500 })
  }
}
