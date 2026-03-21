// scripts/optimize-weights.ts
//
// Random-search weight optimizer for the Prizm confidence model.
// Pre-computes all factor values once per prop, then each iteration
// only does the weighted sum — making 5,000 iterations fast.
//
// Run:  npx tsx scripts/optimize-weights.ts

import { createClient } from '@supabase/supabase-js'
import {
  computeFactors,
  applyWeights,
  type GameLog,
  type PrecomputedFactors,
  type ScoringContext,
  type PlayerLineBias,
  type OpponentStatLeak,
} from '../lib/confidence'
import type { Prop, StatType } from '../types'

// ── Config ────────────────────────────────────────────────────────────────────
const N_ITERATIONS   = 5000
const MIN_HIGH_PROPS = 60   // middle ground: quality + enough volume
const TOP_K          = 20

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const WEIGHT_KEYS = [
  'lineValue', 'matchupEdge', 'last20HitRate', 'trend',
  'seasonCushion', 'pace', 'newsInjury', 'restDays',
  'blowout', 'homeAway', 'vsOpponent',
] as const
type WeightKey = typeof WEIGHT_KEYS[number]

const BASELINE: Record<WeightKey, number> = {
  lineValue:      0.06,
  matchupEdge:    0.04,
  last20HitRate:  0.30,
  trend:          0.09,
  seasonCushion:  0.07,
  pace:           0.08,
  newsInjury:     0.08,
  restDays:       0.08,
  blowout:        0.11,
  homeAway:       0.07,
  vsOpponent:     0.02,
}

// ── Dirichlet(1,...,1) sampler ────────────────────────────────────────────────
function sampleDirichlet(n: number): number[] {
  const gammas = Array.from({ length: n }, () => -Math.log(Math.random()))
  const sum    = gammas.reduce((s, g) => s + g, 0)
  return gammas.map((g) => g / sum)
}

// ── Stat column map ───────────────────────────────────────────────────────────
const STAT_COL: Record<string, string> = {
  points: 'points', rebounds: 'rebounds', assists: 'assists',
  pra: 'pra', blocks: 'blocks', steals: 'steals', three_pointers: 'fg3m',
}

interface GameLogRow {
  player_name: string; game_date: string; matchup: string; is_home: boolean
  points: number; rebounds: number; assists: number; pra: number
  blocks: number; steals: number; fg3m: number; minutes: number
}

interface PropRow {
  player_name: string; stat_type: string; direction: string
  line: number; game_date: string; commence_time: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAll<T>(
  supabase: ReturnType<typeof createClient<any, any, any>>,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000; const rows: T[] = []; let from = 0
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: page } = await (build(supabase.from(table)) as any)
      .range(from, from + PAGE - 1) as { data: T[] | null }
    if (!page || page.length === 0) break
    rows.push(...page)
    if (page.length < PAGE) break
    from += PAGE
  }
  return rows
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  // 1. Load OVER props
  console.log('Loading props...')
  const propRows = await loadAll<PropRow>(supabase, 'historical_prop_lines', (q) =>
    q.select('player_name, stat_type, direction, line, game_date, commence_time').eq('direction', 'over')
  )
  console.log(`  ${propRows.length} OVER props`)

  // 2. Load game logs
  const playerSet = [...new Set(propRows.map((p) => p.player_name))]
  console.log(`Loading game logs for ${playerSet.length} players...`)
  const allLogs = await loadAll<GameLogRow>(supabase, 'player_game_logs', (q) =>
    q.select('player_name,game_date,matchup,is_home,points,rebounds,assists,pra,blocks,steals,fg3m,minutes')
     .in('player_name', playerSet).order('game_date', { ascending: false })
  )
  console.log(`  ${allLogs.length} game log rows`)

  // 3. Load bias + leak tables
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
  console.log(`  bias=${biasMap.size} entries  leak=${leakMap.size} entries`)

  // 4. Indexes
  const logsByPlayer = new Map<string, GameLogRow[]>()
  for (const log of allLogs) {
    if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
    logsByPlayer.get(log.player_name)!.push(log)
  }
  const actualByKey = new Map<string, GameLogRow>()
  for (const log of allLogs) actualByKey.set(`${log.player_name}|${log.game_date}`, log)

  // 5. Pre-compute all factor values (the expensive part — done once)
  console.log('Pre-computing factors...')
  const precomputed: PrecomputedFactors[] = []

  for (const p of propRows) {
    const col = STAT_COL[p.stat_type]
    if (!col) continue
    const actual = actualByKey.get(`${p.player_name}|${p.game_date}`)
    if (!actual) continue
    const allPlayerLogs = logsByPlayer.get(p.player_name) ?? []
    const priorLogs = allPlayerLogs
      .filter((g) => g.game_date < p.game_date)
      .map((g): GameLog => ({
        game_date: g.game_date, matchup: g.matchup, is_home: g.is_home,
        points: g.points, rebounds: g.rebounds, assists: g.assists,
        steals: g.steals, blocks: g.blocks, fg3m: g.fg3m, minutes: g.minutes, pra: g.pra,
      }))
    if (priorLogs.length < 3) continue

    const prop: Prop = {
      id: `opt-${p.player_name}-${p.stat_type}-${p.game_date}`,
      player_id: 0, player_name: p.player_name, team: '', opponent: '', game_id: '',
      stat_type: p.stat_type as StatType, direction: 'over', line: p.line,
      commence_time: p.commence_time ?? `${p.game_date}T23:30:00+00:00`,
    }
    // Derive opponent from game log matchup
    const parts = actual.matchup.split('@')
    const opponentAbbr = parts.length === 2
      ? (actual.is_home ? parts[0].trim() : parts[1].trim())
      : null

    const ctx: ScoringContext = {
      playerBias:   biasMap.get(`${p.player_name}|${p.stat_type}`) ?? null,
      opponentLeak: opponentAbbr ? (leakMap.get(`${opponentAbbr}|${p.stat_type}`) ?? null) : null,
      opponentAbbr,
    }
    const actualVal = (actual as unknown as Record<string, number>)[col] as number
    const hit = actualVal > p.line

    precomputed.push(computeFactors(prop, priorLogs, ctx, hit))
  }
  console.log(`  ${precomputed.length} props pre-computed\n`)

  // 6. Baseline
  let baseHigh = 0, baseHits = 0
  for (const f of precomputed) {
    const { label } = applyWeights(f, BASELINE)
    if (label !== 'LOCK') continue
    baseHigh++
    if (f.hit) baseHits++
  }
  const baseHR = baseHigh > 0 ? baseHits / baseHigh : 0
  console.log(`Baseline (v5.7): LOCK=${baseHigh} props, ${(baseHR * 100).toFixed(1)}% hit rate\n`)

  // 7. Random search — now just weighted sums, very fast
  console.log(`Running ${N_ITERATIONS} iterations...`)
  type Result = { weights: Record<WeightKey, number>; total: number; hits: number; hitRate: number }
  const topResults: Result[] = []

  const t0 = Date.now()
  for (let i = 0; i < N_ITERATIONS; i++) {
    if (i > 0 && i % 1000 === 0) {
      console.log(`  ${i}/${N_ITERATIONS} (${((Date.now() - t0) / 1000).toFixed(1)}s)...`)
    }

    const sample  = sampleDirichlet(WEIGHT_KEYS.length)
    const weights = Object.fromEntries(WEIGHT_KEYS.map((k, j) => [k, sample[j]])) as Record<WeightKey, number>

    let total = 0, hits = 0
    for (const f of precomputed) {
      const { label } = applyWeights(f, weights)
      if (label !== 'LOCK') continue
      total++
      if (f.hit) hits++
    }

    if (total < MIN_HIGH_PROPS) continue
    const hitRate = hits / total
    topResults.push({ weights, total, hits, hitRate })
    topResults.sort((a, b) => b.hitRate - a.hitRate)
    if (topResults.length > TOP_K) topResults.pop()
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\nDone in ${elapsed}s\n`)

  // 7. Print results table
  console.log('═'.repeat(90))
  console.log(`TOP ${TOP_K} WEIGHT COMBINATIONS  (min ${MIN_HIGH_PROPS} LOCK props, ${N_ITERATIONS} iterations)`)
  console.log('═'.repeat(90))
  const header = `${'Rank'.padEnd(5)} ${'HitRate'.padEnd(9)} ${'HIGH'.padEnd(6)} ${'Hits'.padEnd(6)} ` +
    WEIGHT_KEYS.map((k) => k.slice(0, 7).padEnd(8)).join('')
  console.log(header)
  console.log('─'.repeat(90))

  for (let i = 0; i < topResults.length; i++) {
    const r = topResults[i]
    const cols = WEIGHT_KEYS.map((k) => (r.weights[k] * 100).toFixed(1).padStart(5) + '%  ')
    console.log(`#${String(i + 1).padEnd(4)} ${(r.hitRate * 100).toFixed(1).padStart(6)}%   ${String(r.total).padEnd(6)} ${String(r.hits).padEnd(6)} ${cols.join('')}`)
  }

  // Baseline row
  const bCols = WEIGHT_KEYS.map((k) => (BASELINE[k] * 100).toFixed(1).padStart(5) + '%  ')
  console.log('─'.repeat(90))
  console.log(`${'BASE'.padEnd(5)} ${(baseHR * 100).toFixed(1).padStart(6)}%   ${String(baseHigh).padEnd(6)} ${String(baseHits).padEnd(6)} ${bCols.join('')}`)

  // 8. Consensus of top 10
  const top10 = topResults.slice(0, 10)
  if (top10.length > 0) {
    console.log('\n' + '═'.repeat(60))
    console.log('CONSENSUS — average of top 10 results:')
    console.log('─'.repeat(60))
    for (const k of WEIGHT_KEYS) {
      const avg  = top10.reduce((s, r) => s + r.weights[k], 0) / top10.length
      const diff = avg - BASELINE[k]
      const arrow = diff > 0.01 ? '↑' : diff < -0.01 ? '↓' : '='
      console.log(`  ${k.padEnd(16)} ${(avg * 100).toFixed(1).padStart(5)}%  (baseline: ${(BASELINE[k] * 100).toFixed(1)}%  ${arrow})`)
    }
    const avgHR  = top10.reduce((s, r) => s + r.hitRate, 0) / top10.length
    const avgCnt = top10.reduce((s, r) => s + r.total,   0) / top10.length
    console.log(`\n  Avg LOCK hit rate: ${(avgHR * 100).toFixed(1)}%  (baseline: ${(baseHR * 100).toFixed(1)}%)`)
    console.log(`  Avg LOCK count:    ${avgCnt.toFixed(0)} props  (baseline: ${baseHigh})`)
  }
}

main().catch(console.error)
