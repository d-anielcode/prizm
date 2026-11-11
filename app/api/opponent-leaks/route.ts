// /api/opponent-leaks
//
// Analyzes historical_prop_lines vs player_game_logs to detect team-specific
// defensive leaks — opponents that give up a specific stat at an elevated rate
// regardless of their overall defensive rank.
//
// GET /api/opponent-leaks?action=analyze  — compute + upsert to opponent_stat_leaks
// GET /api/opponent-leaks?action=view     — return current table (default)
//
// Opponent detection: uses matchup field from game_logs (e.g. "OKC @ LAL")
//   is_home=true  → player is home team (right of @), opponent is away (left of @)
//   is_home=false → player is away team (left of @), opponent is home (right of @)
//
// MIN_SAMPLES = 10 per (opponent, stat_type) to reduce noise.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'

export const maxDuration = 120

const STAT_COL: Record<string, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  pra:            'pra',
  blocks:         'blocks',
  steals:         'steals',
  three_pointers: 'fg3m',
}

const MIN_SAMPLES = 10

interface PropRow {
  player_name: string
  stat_type:   string
  line:        number
  game_date:   string
}

interface LogRow {
  player_name: string
  game_date:   string
  matchup:     string
  is_home:     boolean
  points:      number
  rebounds:    number
  assists:     number
  pra:         number
  blocks:      number
  steals:      number
  fg3m:        number
}

function median(vals: number[]): number {
  if (vals.length === 0) return 1
  const sorted = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** Parse opponent abbreviation from ESPN matchup string.
 *  Format: "AWAY @ HOME"  e.g. "OKC @ LAL"
 *  is_home=true  → player is HOME, opponent is AWAY (before @)
 *  is_home=false → player is AWAY, opponent is HOME (after @)
 */
function parseOpponent(matchup: string, isHome: boolean): string | null {
  const parts = matchup.split('@')
  if (parts.length !== 2) return null
  return isHome ? parts[0].trim() : parts[1].trim()
}

export async function GET(req: Request) {
  const url    = new URL(req.url)
  const action = url.searchParams.get('action') ?? 'view'

  // Analyze action writes to the DB — require cron auth
  if (action !== 'view') {
    const authError = requireCronAuth(req)
    if (authError) return authError
  }

  if (action === 'view') {
    const { data, error } = await supabase
      .from('opponent_stat_leaks')
      .select('*')
      .order('over_hit_rate', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ count: data?.length ?? 0, rows: data })
  }

  // ── action=analyze ───────────────────────────────────────────────────────────

  // 1. Load all OVER props from historical_prop_lines
  const props: PropRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name, stat_type, line, game_date')
        .eq('direction', 'over')
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) props.push(row as PropRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[opponent-leaks] Loaded ${props.length} OVER props`)

  // 2. Load game logs for those players
  const playerSet = [...new Set(props.map((p) => p.player_name))]
  const allLogs: LogRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, matchup, is_home, points, rebounds, assists, pra, blocks, steals, fg3m')
        .in('player_name', playerSet)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) allLogs.push(row as LogRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[opponent-leaks] Loaded ${allLogs.length} game log rows`)

  // Index logs by "player|date"
  const logByKey = new Map<string, LogRow>()
  for (const log of allLogs) {
    logByKey.set(`${log.player_name}|${log.game_date}`, log)
  }

  // 3. For each (opponent_team, stat_type): collect actual vs line
  type Key = string  // "opponent|stat"
  const leakMap = new Map<Key, { hits: number; total: number; ratios: number[] }>()

  for (const prop of props) {
    const col = STAT_COL[prop.stat_type]
    if (!col) continue

    const log = logByKey.get(`${prop.player_name}|${prop.game_date}`)
    if (!log) continue

    const opponent = parseOpponent(log.matchup, log.is_home)
    if (!opponent) continue

    const actual = (log as unknown as Record<string, number>)[col]
    if (actual == null || prop.line <= 0) continue

    const key = `${opponent}|${prop.stat_type}`
    if (!leakMap.has(key)) leakMap.set(key, { hits: 0, total: 0, ratios: [] })
    const entry = leakMap.get(key)!
    entry.total++
    if (actual > prop.line) entry.hits++
    entry.ratios.push(actual / prop.line)
  }

  // 4. Build rows — only entries with enough samples
  const leakRows: {
    opponent_team: string
    stat_type:     string
    over_hit_rate: number
    median_ratio:  number
    sample_count:  number
    updated_at:    string
  }[] = []

  for (const [key, data] of leakMap) {
    if (data.total < MIN_SAMPLES) continue
    const [opponent_team, stat_type] = key.split('|')
    leakRows.push({
      opponent_team,
      stat_type,
      over_hit_rate: Math.round((data.hits / data.total) * 1000) / 1000,
      median_ratio:  Math.round(median(data.ratios) * 1000) / 1000,
      sample_count:  data.total,
      updated_at:    new Date().toISOString(),
    })
  }

  console.log(`[opponent-leaks] ${leakRows.length} opponent/stat entries to upsert`)

  // 5. Upsert in batches
  let upserted = 0
  const BATCH = 500
  for (let i = 0; i < leakRows.length; i += BATCH) {
    const batch = leakRows.slice(i, i + BATCH)
    const { error } = await supabase
      .from('opponent_stat_leaks')
      .upsert(batch, { onConflict: 'opponent_team,stat_type' })
    if (error) console.error('[opponent-leaks] Upsert error:', error.message)
    else upserted += batch.length
  }

  // 6. Return summary — top leaks and strongest defenses per stat
  const sorted = [...leakRows].sort((a, b) => b.over_hit_rate - a.over_hit_rate)
  const topLeaks    = sorted.slice(0, 20)
  const topDefenses = sorted.slice(-20).reverse()

  // Group top leaks by stat for easy reading
  const byStatType: Record<string, typeof leakRows> = {}
  for (const row of leakRows) {
    if (!byStatType[row.stat_type]) byStatType[row.stat_type] = []
    byStatType[row.stat_type].push(row)
  }
  const topLeaksByStat: Record<string, typeof leakRows> = {}
  for (const [stat, rows] of Object.entries(byStatType)) {
    topLeaksByStat[stat] = rows
      .sort((a, b) => b.over_hit_rate - a.over_hit_rate)
      .slice(0, 5)
  }

  return NextResponse.json({
    propsAnalyzed:    props.length,
    entriesGenerated: leakRows.length,
    upserted,
    topLeaks,
    topDefenses,
    topLeaksByStat,
  })
}
