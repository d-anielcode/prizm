// scripts/optimize-weights.ts
//
// Random-search + hill-climbing weight optimizer for the Prizm confidence model.
// Pre-computes all factor values once per prop, then each iteration does only
// the weighted sum — making 50,000 iterations fast (~60-90s).
//
// Run:  npx tsx scripts/optimize-weights.ts
//
// Algorithm:
//   Phase 1 — Random search (50K Dirichlet samples)
//              Explores the full weight simplex uniformly
//   Phase 2 — Hill climbing (starts from top 10 Phase-1 results)
//              Perturbs each weight ±0.01 / ±0.02 repeatedly until no improvement
//   Phase 3 — Threshold scan for top result
//              Finds the optimal base LOCK threshold (64-78) for the best weight vector
//
// Both weights AND the global LOCK threshold offset are optimized jointly in Phase 1.
// Threshold scan: [64, 66, 68, 70, 72, 74, 76, 78] applied as the base threshold
// (stat-specific adjustments remain relative: assists/pra +6, 3PM +4 above base).
//
// Training data: real sportsbook lines only (historical_prop_lines).
// Synthetic lines excluded due to calibration noise.

import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

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
const N_ITERATIONS       = 50_000   // Phase 1 random search iterations
const MIN_HIGH_PROPS     = 80       // min LOCK props to qualify a result
const TOP_K              = 20       // keep top K results from Phase 1
const HILL_CLIMB_STARTS  = 10       // Phase 2: start from top N results
const PERTURB_STEPS      = [0.02, 0.01, 0.005]  // perturbation magnitudes
const PERTURB_ROUNDS     = 30       // max rounds of hill climbing per start

// LOCK thresholds to scan. Stat-specific offsets (assists/pra +6, 3PM +4) are
// added on top of the base threshold during scoring.
const THRESHOLD_SCAN = [64, 66, 68, 70, 72, 74, 76, 78]

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
  lineValue:      0.02,   // v6.0 — 24-25+25-26 seasons, 50K iterations + hill-climbing
  matchupEdge:    0.14,
  last20HitRate:  0.18,
  trend:          0.12,
  seasonCushion:  0.02,
  pace:           0.05,
  newsInjury:     0.09,
  restDays:       0.05,
  blowout:        0.11,
  homeAway:       0.18,
  vsOpponent:     0.04,
}
const BASELINE_THRESHOLD = 68

// Stat-specific threshold offsets relative to base (mirrors confidence.ts logic)
const STAT_THRESHOLD_OFFSET: Partial<Record<StatType, number>> = {
  assists:        6,   // base + 6
  pra:            6,
  three_pointers: 4,   // base + 4
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sampleDirichlet(n: number): number[] {
  const gammas = Array.from({ length: n }, () => -Math.log(Math.random()))
  const sum    = gammas.reduce((s, g) => s + g, 0)
  return gammas.map((g) => g / sum)
}

function clampWeight(w: number): number {
  return Math.max(0.001, Math.min(0.999, w))
}

/** Normalize weights so they sum to 1 */
function normalizeWeights(w: Record<WeightKey, number>): Record<WeightKey, number> {
  const sum = WEIGHT_KEYS.reduce((s, k) => s + w[k], 0)
  return Object.fromEntries(WEIGHT_KEYS.map((k) => [k, w[k] / sum])) as Record<WeightKey, number>
}

/** Score precomputed factors with given weights AND base lock threshold.
 *  Returns whether the prop qualifies as LOCK. */
function isLock(f: PrecomputedFactors, weights: Record<WeightKey, number>, baseThreshold: number): boolean {
  const { score } = applyWeights(f, weights)
  const offset = STAT_THRESHOLD_OFFSET[f.statType] ?? 0
  return score >= baseThreshold + offset
}

/** Evaluate a (weights, threshold) combo. Returns { total, hits, hitRate } or null if below floor. */
function evaluate(
  precomputed: PrecomputedFactors[],
  weights: Record<WeightKey, number>,
  baseThreshold: number,
  minProps = MIN_HIGH_PROPS,
): { total: number; hits: number; hitRate: number } | null {
  let total = 0, hits = 0
  for (const f of precomputed) {
    if (!isLock(f, weights, baseThreshold)) continue
    total++
    if (f.hit) hits++
  }
  if (total < minProps) return null
  return { total, hits, hitRate: hits / total }
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

  // ── 1. Load props ──────────────────────────────────────────────────────────
  // Real sportsbook lines only. Synthetic excluded: calibration noise biases signal patterns.
  console.log('Loading props (real sportsbook lines only)...')
  const propRows = await loadAll<PropRow>(supabase, 'historical_prop_lines', (q) =>
    q.select('player_name, stat_type, direction, line, game_date, commence_time').eq('direction', 'over')
  )
  console.log(`  ${propRows.length} OVER props`)

  // ── 2. Load game logs (both 24-25 and 25-26 seasons if available) ──────────
  const playerSet = [...new Set(propRows.map((p) => p.player_name))]
  console.log(`Loading game logs for ${playerSet.length} players...`)
  const allLogs = await loadAll<GameLogRow>(supabase, 'player_game_logs', (q) =>
    q.select('player_name,game_date,matchup,is_home,points,rebounds,assists,pra,blocks,steals,fg3m,minutes')
     .in('player_name', playerSet).order('game_date', { ascending: false })
  )
  console.log(`  ${allLogs.length} game log rows`)

  // Season breakdown
  const logs2425 = allLogs.filter((g) => g.game_date < '2025-10-01').length
  const logs2526 = allLogs.filter((g) => g.game_date >= '2025-10-01').length
  console.log(`  24-25 season: ${logs2425} rows  |  25-26 season: ${logs2526} rows`)

  // ── 3. Load bias + leak tables ─────────────────────────────────────────────
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

  // ── 4. Build indexes ────────────────────────────────────────────────────────
  const logsByPlayer = new Map<string, GameLogRow[]>()
  for (const log of allLogs) {
    if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
    logsByPlayer.get(log.player_name)!.push(log)
  }
  const actualByKey = new Map<string, GameLogRow>()
  for (const log of allLogs) actualByKey.set(`${log.player_name}|${log.game_date}`, log)

  // ── 5. Pre-compute all factor values (done once — the expensive part) ───────
  console.log('\nPre-computing factors...')
  const precomputed: PrecomputedFactors[] = []

  for (const p of propRows) {
    const col = STAT_COL[p.stat_type]
    if (!col) continue
    const actual = actualByKey.get(`${p.player_name}|${p.game_date}`)
    if (!actual) continue

    const allPlayerLogs = logsByPlayer.get(p.player_name) ?? []
    // Prior logs only — strictly before game date (no lookahead)
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

  // ── 6. Baseline ─────────────────────────────────────────────────────────────
  const baseResult = evaluate(precomputed, BASELINE, BASELINE_THRESHOLD, 1)
  const baseHR = baseResult ? baseResult.hitRate : 0
  const baseHigh = baseResult ? baseResult.total : 0
  const baseHits = baseResult ? baseResult.hits : 0
  console.log(`Baseline (v5.9): LOCK=${baseHigh} props, ${(baseHR * 100).toFixed(1)}% hit rate  (threshold=${BASELINE_THRESHOLD})\n`)

  // ── 7. Phase 1 — Random search ──────────────────────────────────────────────
  console.log(`Phase 1: Random search — ${N_ITERATIONS.toLocaleString()} iterations × ${THRESHOLD_SCAN.length} thresholds...`)
  type Result = {
    weights: Record<WeightKey, number>
    threshold: number
    total: number
    hits: number
    hitRate: number
  }
  const topResults: Result[] = []

  const t0 = Date.now()
  for (let i = 0; i < N_ITERATIONS; i++) {
    if (i > 0 && i % 10000 === 0) {
      console.log(`  ${(i / 1000).toFixed(0)}K/${(N_ITERATIONS / 1000).toFixed(0)}K  (${((Date.now() - t0) / 1000).toFixed(1)}s)  top hit rate: ${topResults[0] ? (topResults[0].hitRate * 100).toFixed(1) + '%' : 'n/a'}`)
    }

    const sample  = sampleDirichlet(WEIGHT_KEYS.length)
    const weights = Object.fromEntries(WEIGHT_KEYS.map((k, j) => [k, sample[j]])) as Record<WeightKey, number>

    // Try each threshold for this weight vector
    for (const threshold of THRESHOLD_SCAN) {
      const r = evaluate(precomputed, weights, threshold)
      if (!r) continue

      topResults.push({ weights, threshold, ...r })
      topResults.sort((a, b) => b.hitRate - a.hitRate)
      if (topResults.length > TOP_K) topResults.pop()
    }
  }

  const phase1Elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  Done in ${phase1Elapsed}s. Top hit rate: ${topResults[0] ? (topResults[0].hitRate * 100).toFixed(1) + '%' : 'n/a'}\n`)

  // ── 8. Phase 2 — Hill climbing ──────────────────────────────────────────────
  console.log(`Phase 2: Hill climbing from top ${HILL_CLIMB_STARTS} results...`)
  const hillResults: Result[] = [...topResults]
  const t1 = Date.now()

  const starts = topResults.slice(0, HILL_CLIMB_STARTS)
  for (let s = 0; s < starts.length; s++) {
    let best = starts[s]
    let improved = true
    let round = 0

    while (improved && round < PERTURB_ROUNDS) {
      improved = false
      round++

      for (const step of PERTURB_STEPS) {
        for (const key of WEIGHT_KEYS) {
          for (const sign of [+1, -1]) {
            // Perturb one weight, redistribute across all others proportionally
            const w = { ...best.weights }
            const delta = sign * step
            const newVal = clampWeight(w[key] + delta)
            const actualDelta = newVal - w[key]
            if (Math.abs(actualDelta) < 1e-6) continue

            w[key] = newVal
            // Redistribute deficit/surplus across remaining keys
            const remaining = WEIGHT_KEYS.filter((k) => k !== key)
            const remainingSum = remaining.reduce((s, k) => s + w[k], 0)
            if (remainingSum < 1e-6) continue
            const scale = (1 - newVal) / remainingSum
            for (const k of remaining) w[k] = clampWeight(w[k] * scale)
            const normalized = normalizeWeights(w)

            // Try current threshold and adjacent thresholds
            const thresholdsToTry = [best.threshold]
            const tidx = THRESHOLD_SCAN.indexOf(best.threshold)
            if (tidx > 0) thresholdsToTry.push(THRESHOLD_SCAN[tidx - 1])
            if (tidx < THRESHOLD_SCAN.length - 1) thresholdsToTry.push(THRESHOLD_SCAN[tidx + 1])

            for (const t of thresholdsToTry) {
              const r = evaluate(precomputed, normalized, t)
              if (!r) continue
              if (r.hitRate > best.hitRate + 1e-6) {
                best = { weights: normalized, threshold: t, ...r }
                improved = true
              }
            }
          }
        }
      }
    }

    hillResults.push(best)
    console.log(`  Start ${s + 1}/${starts.length}: ${(best.hitRate * 100).toFixed(1)}% (${best.total} props, threshold=${best.threshold}, ${round} rounds)`)
  }

  // Merge hill results into global top list
  for (const r of hillResults) {
    topResults.push(r)
  }
  topResults.sort((a, b) => b.hitRate - a.hitRate)
  // Dedupe by threshold + first few weights (rough dedup)
  const seen = new Set<string>()
  const deduped = topResults.filter((r) => {
    const key = `${r.threshold}|${r.total}|${(r.hitRate * 1000).toFixed(0)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  deduped.sort((a, b) => b.hitRate - a.hitRate)

  const phase2Elapsed = ((Date.now() - t1) / 1000).toFixed(1)
  console.log(`  Hill climbing done in ${phase2Elapsed}s. Best hit rate: ${deduped[0] ? (deduped[0].hitRate * 100).toFixed(1) + '%' : 'n/a'}\n`)

  // ── 9. Print results table ───────────────────────────────────────────────────
  const DISPLAY = Math.min(TOP_K, deduped.length)
  console.log('═'.repeat(100))
  console.log(`TOP ${DISPLAY} WEIGHT COMBINATIONS  (min ${MIN_HIGH_PROPS} LOCK props)`)
  console.log('═'.repeat(100))
  const header = `${'Rank'.padEnd(5)} ${'HitRate'.padEnd(9)} ${'LOCK'.padEnd(6)} ${'Hits'.padEnd(6)} ${'Thresh'.padEnd(8)} ` +
    WEIGHT_KEYS.map((k) => k.slice(0, 7).padEnd(8)).join('')
  console.log(header)
  console.log('─'.repeat(100))

  for (let i = 0; i < DISPLAY; i++) {
    const r = deduped[i]
    const cols = WEIGHT_KEYS.map((k) => (r.weights[k] * 100).toFixed(1).padStart(5) + '%  ')
    console.log(`#${String(i + 1).padEnd(4)} ${(r.hitRate * 100).toFixed(1).padStart(6)}%   ${String(r.total).padEnd(6)} ${String(r.hits).padEnd(6)} t=${String(r.threshold).padEnd(5)} ${cols.join('')}`)
  }

  // Baseline row
  const bCols = WEIGHT_KEYS.map((k) => (BASELINE[k] * 100).toFixed(1).padStart(5) + '%  ')
  console.log('─'.repeat(100))
  console.log(`${'BASE'.padEnd(5)} ${(baseHR * 100).toFixed(1).padStart(6)}%   ${String(baseHigh).padEnd(6)} ${String(baseHits).padEnd(6)} t=${String(BASELINE_THRESHOLD).padEnd(5)} ${bCols.join('')}`)

  // ── 10. Consensus of top 10 ───────────────────────────────────────────────────
  const top10 = deduped.slice(0, 10)
  if (top10.length > 0) {
    console.log('\n' + '═'.repeat(70))
    console.log('CONSENSUS — average of top 10 results:')
    console.log('─'.repeat(70))
    for (const k of WEIGHT_KEYS) {
      const avg  = top10.reduce((s, r) => s + r.weights[k], 0) / top10.length
      const diff = avg - BASELINE[k]
      const arrow = diff > 0.015 ? '↑↑' : diff > 0.005 ? '↑' : diff < -0.015 ? '↓↓' : diff < -0.005 ? '↓' : '='
      console.log(`  ${k.padEnd(16)} ${(avg * 100).toFixed(1).padStart(5)}%  (baseline: ${(BASELINE[k] * 100).toFixed(1)}%  ${arrow})`)
    }
    const avgHR    = top10.reduce((s, r) => s + r.hitRate,   0) / top10.length
    const avgCnt   = top10.reduce((s, r) => s + r.total,     0) / top10.length
    const avgThresh = top10.reduce((s, r) => s + r.threshold, 0) / top10.length

    console.log(`\n  Avg LOCK hit rate:  ${(avgHR * 100).toFixed(1)}%  (baseline: ${(baseHR * 100).toFixed(1)}%)`)
    console.log(`  Avg LOCK count:     ${avgCnt.toFixed(0)} props  (baseline: ${baseHigh})`)
    console.log(`  Avg LOCK threshold: ${avgThresh.toFixed(1)}  (baseline: ${BASELINE_THRESHOLD})`)

    // Recommend the #1 result
    const best = deduped[0]
    console.log('\n' + '═'.repeat(70))
    console.log('RECOMMENDED (best single result):')
    console.log('─'.repeat(70))
    console.log(`  Hit rate:  ${(best.hitRate * 100).toFixed(1)}%  (${best.hits}/${best.total} LOCK props)`)
    console.log(`  Threshold: ${best.threshold}  (stat-specific: assists/pra +6, 3PM +4)`)
    console.log('\n  const W = {')
    for (const k of WEIGHT_KEYS) {
      console.log(`    ${k.padEnd(16)} ${best.weights[k].toFixed(3)},`)
    }
    console.log('  } as const  // sum = ' + WEIGHT_KEYS.reduce((s, k) => s + best.weights[k], 0).toFixed(3))
    if (best.threshold !== BASELINE_THRESHOLD) {
      console.log(`\n  // Update LOCK thresholds in getLabel():`)
      console.log(`  //   base:         ${best.threshold}  (was ${BASELINE_THRESHOLD})`)
      console.log(`  //   assists/pra:  ${best.threshold + 6}  (was ${BASELINE_THRESHOLD + 6})`)
      console.log(`  //   3PM:          ${best.threshold + 4}  (was ${BASELINE_THRESHOLD + 4})`)
    }
    console.log('═'.repeat(70))
  }
}

main().catch(console.error)
