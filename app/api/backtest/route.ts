// /api/backtest
//
// Retroactively scores every prop in historical_prop_lines and/or synthetic_prop_lines
// using the confidence model, then compares to actual game results in player_game_logs.
//
// GET /api/backtest?mode=real|synthetic|combined
//   mode=real       — historical_prop_lines only (Feb 4 – Mar 19, real sportsbook lines)
//   mode=synthetic  — synthetic_prop_lines only (Dec 1 – Feb 3, model-generated lines)
//   mode=combined   — both sources together (default)
//
// Note: backtest scoring uses game-log-based factors only (lineValue, hitRate, trend,
// cushion, homeAway, vsOpponent, restDays, dataFreshness). Factors requiring live data
// (matchupEdge, pace, spread, injury) default to neutral (0.50). This tests the core
// signal quality of the model's log-derived factors (~62% of total weight).
//
// Returns: hit rates by confidence tier and stat type, plus calibration data.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { scoreProps, type PlayerLineBias, type OpponentStatLeak, type ScoringContext } from '@/lib/confidence'
import type { Prop, StatType } from '@/types'

export const maxDuration = 120

const STAT_COL: Record<string, keyof GameLogRow> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  pra:            'pra',
  blocks:         'blocks',
  steals:         'steals',
  three_pointers: 'fg3m',
}

interface GameLogRow {
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
  minutes:     number
}

interface PropRow {
  player_name:   string
  stat_type:     string
  direction:     string
  line:          number
  game_date:     string
  commence_time: string | null
  odds?:         number | null
}

interface TierStats {
  total:  number
  hits:   number
  hitRate: number | null
}

export async function GET(req: Request) {
  const url  = new URL(req.url)
  const mode = (url.searchParams.get('mode') ?? 'combined') as 'real' | 'synthetic' | 'combined'

  // ── 1. Load all prop lines ──────────────────────────────────────────────────
  const props: PropRow[] = []

  async function loadProps(table: 'historical_prop_lines' | 'synthetic_prop_lines') {
    let from = 0
    const PAGE = 1000
    while (true) {
      const q = supabase
        .from(table)
        .select('player_name, stat_type, direction, line, game_date, commence_time' + (table === 'historical_prop_lines' ? ', odds' : ''))
        .range(from, from + PAGE - 1)
      const { data: page } = await q
      if (!page || page.length === 0) break
      for (const row of page) props.push(row as unknown as PropRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  if (mode === 'real' || mode === 'combined')      await loadProps('historical_prop_lines')
  if (mode === 'synthetic' || mode === 'combined') await loadProps('synthetic_prop_lines')

  console.log(`[backtest] ${props.length} props loaded (mode=${mode})`)
  if (props.length === 0) return NextResponse.json({ error: 'No props found for this mode' }, { status: 400 })

  // Dedupe: one prop per (player, stat, direction, game_date)
  // When both real and synthetic exist for same slot, prefer real
  const propMap = new Map<string, PropRow>()
  for (const p of props) {
    const key = `${p.player_name}|${p.stat_type}|${p.direction}|${p.game_date}`
    if (!propMap.has(key) || (p as PropRow & { odds?: number | null }).odds != null) {
      propMap.set(key, p)
    }
  }
  const dedupedProps = [...propMap.values()]
  console.log(`[backtest] ${dedupedProps.length} unique props after dedupe`)

  // ── 2. Load all game logs ───────────────────────────────────────────────────
  const playerSet = [...new Set(dedupedProps.map((p) => p.player_name))]
  const allLogs: GameLogRow[] = []

  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, matchup, is_home, points, rebounds, assists, pra, blocks, steals, fg3m, minutes')
        .in('player_name', playerSet)
        .order('game_date', { ascending: false })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) allLogs.push(row as GameLogRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  console.log(`[backtest] ${allLogs.length} game log rows loaded`)

  // ── 2b. Load player bias and opponent leaks ──────────────────────────────────
  const { data: biasRows } = await supabase
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

  const { data: leakRows } = await supabase
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
  console.log(`[backtest] bias=${biasMap.size} leak=${leakMap.size}`)

  // Index: player_name → logs sorted descending (already sorted from query)
  const logsByPlayer = new Map<string, GameLogRow[]>()
  for (const log of allLogs) {
    if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
    logsByPlayer.get(log.player_name)!.push(log)
  }

  // Index: "player|date" → actual game log row (for result lookup)
  const actualByPlayerDate = new Map<string, GameLogRow>()
  for (const log of allLogs) {
    actualByPlayerDate.set(`${log.player_name}|${log.game_date}`, log)
  }

  // ── 3. Score each prop and compare to actual result ─────────────────────────
  const tierStats: Record<string, TierStats> = {
    LOCK: { total: 0, hits: 0, hitRate: null },
    PLAY: { total: 0, hits: 0, hitRate: null },
    LEAN: { total: 0, hits: 0, hitRate: null },
    FADE: { total: 0, hits: 0, hitRate: null },
  }

  // Per-stat-type breakdown
  const statStats: Record<string, Record<string, TierStats>> = {}
  const STAT_TYPES = Object.keys(STAT_COL)
  for (const st of STAT_TYPES) {
    statStats[st] = {
      LOCK: { total: 0, hits: 0, hitRate: null },
      PLAY: { total: 0, hits: 0, hitRate: null },
      LEAN: { total: 0, hits: 0, hitRate: null },
      FADE: { total: 0, hits: 0, hitRate: null },
    }
  }

  // Score distribution buckets (10-pt buckets: 10-19, 20-29, ... 90-95)
  const scoreBuckets: Record<string, { total: number; hits: number }> = {}
  for (let b = 10; b <= 90; b += 10) scoreBuckets[`${b}-${b + 9}`] = { total: 0, hits: 0 }

  let skipped = 0
  let scored  = 0

  for (const prop of dedupedProps) {
    // Only evaluate OVER props (line is same for over/under, avoids double-counting)
    if (prop.direction !== 'over') continue

    const col = STAT_COL[prop.stat_type]
    if (!col) continue

    const actual = actualByPlayerDate.get(`${prop.player_name}|${prop.game_date}`)
    if (!actual) { skipped++; continue } // player DNP or log missing

    const allPlayerLogs = logsByPlayer.get(prop.player_name) ?? []
    // Prior logs only (strictly before game date)
    const priorLogs = allPlayerLogs.filter((g) => g.game_date < prop.game_date)
    if (priorLogs.length < 3) { skipped++; continue }

    // Build a Prop object for scoreProps (unused required fields set to defaults)
    const propObj: Prop = {
      id:            `backtest-${prop.player_name}-${prop.stat_type}-${prop.game_date}`,
      player_id:     0,
      player_name:   prop.player_name,
      team:          '',
      opponent:      '',
      game_id:       '',
      stat_type:     prop.stat_type as StatType,
      direction:     prop.direction as 'over' | 'under',
      line:          prop.line,
      odds:          (prop as PropRow & { odds?: number | null }).odds ?? undefined,
      commence_time: prop.commence_time ?? `${prop.game_date}T23:30:00+00:00`,
    }

    // Derive opponent abbreviation from the game log's matchup field
    const gameLog = actualByPlayerDate.get(`${prop.player_name}|${prop.game_date}`)
    let opponentAbbr: string | null = null
    if (gameLog) {
      const parts = gameLog.matchup.split('@')
      if (parts.length === 2) {
        opponentAbbr = gameLog.is_home ? parts[0].trim() : parts[1].trim()
      }
    }

    const ctx: ScoringContext = {
      playerBias:   biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
      opponentLeak: opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
      opponentAbbr,
    }

    const result = scoreProps(propObj, priorLogs, null, ctx)
    const label  = result.confidence_label

    // Did the OVER hit?
    const actualVal = actual[col] as number
    const hit = actualVal > prop.line

    // Update tier stats
    tierStats[label].total++
    if (hit) tierStats[label].hits++

    // Update stat-type breakdown
    if (statStats[prop.stat_type]) {
      statStats[prop.stat_type][label].total++
      if (hit) statStats[prop.stat_type][label].hits++
    }

    // Score distribution bucket
    const bucket = Math.min(90, Math.floor(result.confidence_score / 10) * 10)
    const bucketKey = `${bucket}-${bucket + 9}`
    if (scoreBuckets[bucketKey]) {
      scoreBuckets[bucketKey].total++
      if (hit) scoreBuckets[bucketKey].hits++
    }

    scored++
  }

  // Compute hit rates
  for (const tier of Object.values(tierStats)) {
    tier.hitRate = tier.total > 0 ? Math.round((tier.hits / tier.total) * 1000) / 10 : null
  }
  for (const st of Object.keys(statStats)) {
    for (const tier of Object.values(statStats[st])) {
      tier.hitRate = tier.total > 0 ? Math.round((tier.hits / tier.total) * 1000) / 10 : null
    }
  }
  const bucketResults = Object.entries(scoreBuckets).map(([range, d]) => ({
    range,
    total:   d.total,
    hits:    d.hits,
    hitRate: d.total > 0 ? Math.round((d.hits / d.total) * 1000) / 10 : null,
  }))

  // Overall
  const totalEval = Object.values(tierStats).reduce((s, t) => s + t.total, 0)
  const totalHits = Object.values(tierStats).reduce((s, t) => s + t.hits, 0)

  return NextResponse.json({
    mode,
    propsLoaded:   dedupedProps.length,
    propsScored:   scored,
    propsSkipped:  skipped,
    overall: {
      total:   totalEval,
      hits:    totalHits,
      hitRate: totalEval > 0 ? Math.round((totalHits / totalEval) * 1000) / 10 : null,
    },
    byTier:   tierStats,
    byStatType: statStats,
    scoreDistribution: bucketResults,
    note: 'Scores use game-log factors only. matchupEdge/pace/spread/injury default to 0.50 (neutral) — live model will score differently for these factors.',
  })
}
