// /api/player-bias
//
// Analyzes historical_prop_lines vs actual player_game_logs to detect systematic
// per-player line bias — i.e., players the book consistently underprices or overprices.
//
// GET /api/player-bias?action=analyze  — compute + upsert bias to player_line_bias table
// GET /api/player-bias?action=view     — return current table contents (default)
//
// Bias model:
//   hit_rate    = fraction of OVER props where actual > line  (>0.50 = book underpricing)
//   median_ratio = median(actual / line) across all sampled games
//   sample_count = number of game/stat pairs used
//
// Only uses historical_prop_lines (real sportsbook lines) — synthetic lines excluded.
// Requires minimum 6 games per player/stat to generate a bias entry.

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

const MIN_SAMPLES = 6

interface PropRow {
  player_name:  string
  stat_type:    string
  line:         number
  game_date:    string
}

interface LogRow {
  player_name: string
  game_date:   string
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
      .from('player_line_bias')
      .select('*')
      .order('hit_rate', { ascending: false })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ count: data?.length ?? 0, rows: data })
  }

  // ── action=analyze: compute and upsert ──────────────────────────────────────

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
  console.log(`[player-bias] Loaded ${props.length} OVER props`)

  // 2. Load game logs for all players
  const playerSet = [...new Set(props.map((p) => p.player_name))]
  const allLogs: LogRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, points, rebounds, assists, pra, blocks, steals, fg3m')
        .in('player_name', playerSet)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) allLogs.push(row as LogRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[player-bias] Loaded ${allLogs.length} game log rows`)

  // Index logs by "player|date"
  const logByKey = new Map<string, LogRow>()
  for (const log of allLogs) {
    logByKey.set(`${log.player_name}|${log.game_date}`, log)
  }

  // 3. For each (player, stat_type): collect actual vs line, split into
  //    recent (last 30 days) and historical (all-time) buckets. Each prop
  //    contributes to both — historical is the full count, recent is a subset.
  //
  // Recency decay (added 2026-05-23): the previous version aggregated all
  // historical props with equal weight. By mid-season the long-term aggregate
  // gets stale — a player's role changes, they get traded, etc. The earlier
  // mult=22 counterfactual rebuttal showed amplifying stale signal at high
  // tier introduces noise. Fix: blend recent (70%) with long-term (30%) so
  // current state dominates while we keep the larger sample's stability for
  // cold-start protection.
  const RECENT_WINDOW_DAYS = 30
  const RECENT_WEIGHT = 0.70
  const HISTORICAL_WEIGHT = 0.30
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  type Key = string  // "player|stat"
  interface BiasAccumulator {
    hits: number; total: number; ratios: number[]
    recentHits: number; recentTotal: number
  }
  const hitMap = new Map<Key, BiasAccumulator>()

  for (const prop of props) {
    const col = STAT_COL[prop.stat_type]
    if (!col) continue
    const log = logByKey.get(`${prop.player_name}|${prop.game_date}`)
    if (!log) continue

    const actual = (log as unknown as Record<string, number>)[col] as number
    if (actual == null || prop.line <= 0) continue

    const key = `${prop.player_name}|${prop.stat_type}`
    if (!hitMap.has(key)) {
      hitMap.set(key, { hits: 0, total: 0, ratios: [], recentHits: 0, recentTotal: 0 })
    }
    const entry = hitMap.get(key)!
    const hit = actual > prop.line
    entry.total++
    if (hit) entry.hits++
    entry.ratios.push(actual / prop.line)
    if (prop.game_date >= recentCutoff) {
      entry.recentTotal++
      if (hit) entry.recentHits++
    }
  }

  // 4. Build bias rows — only for entries with enough samples
  const biasRows: {
    player_name:  string
    stat_type:    string
    hit_rate:     number
    median_ratio: number
    sample_count: number
    updated_at:   string
  }[] = []

  for (const [key, data] of hitMap) {
    if (data.total < MIN_SAMPLES) continue
    const [player_name, stat_type] = key.split('|')
    const historicalRate = data.hits / data.total
    let blendedRate: number
    if (data.recentTotal >= 3) {
      // Enough recent data to blend
      const recentRate = data.recentHits / data.recentTotal
      blendedRate = RECENT_WEIGHT * recentRate + HISTORICAL_WEIGHT * historicalRate
    } else {
      // Cold-start fallback: not enough recent data, use historical only
      blendedRate = historicalRate
    }
    biasRows.push({
      player_name,
      stat_type,
      hit_rate:     Math.round(blendedRate * 1000) / 1000,
      median_ratio: Math.round(median(data.ratios) * 1000) / 1000,
      sample_count: data.total,
      updated_at:   new Date().toISOString(),
    })
  }

  console.log(`[player-bias] ${biasRows.length} player/stat entries to upsert`)

  // 5. Upsert in batches
  let upserted = 0
  const BATCH = 500
  for (let i = 0; i < biasRows.length; i += BATCH) {
    const batch = biasRows.slice(i, i + BATCH)
    const { error } = await supabase
      .from('player_line_bias')
      .upsert(batch, { onConflict: 'player_name,stat_type' })
    if (error) console.error('[player-bias] Upsert error:', error.message)
    else upserted += batch.length
  }

  // 6. Return summary + top/bottom biased players
  const sorted = [...biasRows].sort((a, b) => b.hit_rate - a.hit_rate)
  const topOver  = sorted.slice(0, 15)
  const topUnder = sorted.slice(-15).reverse()

  return NextResponse.json({
    propsAnalyzed: props.length,
    entriesGenerated: biasRows.length,
    upserted,
    topOverHitters:  topOver,
    topUnderHitters: topUnder,
  })
}
