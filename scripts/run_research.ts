/**
 * Run all T1-T8 research queries against Supabase and print results.
 * Usage: npx tsx scripts/run_research.ts
 */
import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local
const envPath = resolve(__dirname, '..', '.env.local')
const envContent = readFileSync(envPath, 'utf-8')
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/)
  if (match) process.env[match[1]] = match[2]
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

const PAGE = 1000
async function fetchAll(table: string, select: string, filters: (q: any) => any) {
  const rows: any[] = []
  let from = 0
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1)
    q = filters(q)
    const { data, error } = await q
    if (error) { console.error(`  ERROR on ${table}:`, error.message); break }
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    from += PAGE
  }
  return rows
}

function printTable(headers: string[], rows: any[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)))
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+')
  console.log(headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join('|'))
  console.log(sep)
  for (const row of rows) {
    console.log(row.map((c, i) => ` ${String(c ?? '').padEnd(widths[i])} `).join('|'))
  }
}

// ─── T3: Over-Bias Calibration ──────────────────────────────────────────────
async function runT3() {
  console.log('\n' + '='.repeat(70))
  console.log('  T3: OVER-BIAS CALIBRATION (last 60 days)')
  console.log('  If over hit_rate <= 0.55, penalty was destroying edge')
  console.log('='.repeat(70))

  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
  const rows = await fetchAll('prop_grades', 'stat_type, direction, hit', q =>
    q.not('hit', 'is', null).gte('game_date', cutoff)
  )

  const tally = new Map<string, { hits: number; total: number }>()
  for (const r of rows) {
    const key = `${r.stat_type}|${r.direction}`
    if (!tally.has(key)) tally.set(key, { hits: 0, total: 0 })
    const t = tally.get(key)!
    t.total++
    if (r.hit) t.hits++
  }

  const tableRows = [...tally.entries()]
    .map(([k, v]) => {
      const [stat, dir] = k.split('|')
      const rate = (v.hits / v.total).toFixed(4)
      const flag = dir === 'over' && v.hits / v.total <= 0.55 ? ' <<<< PENALTY UNJUSTIFIED' : ''
      return [stat, dir, v.total, v.hits, rate + flag]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])))

  printTable(['stat_type', 'direction', 'total', 'hits', 'hit_rate'], tableRows)
}

// ─── T4: Score Bucket Calibration ───────────────────────────────────────────
async function runT4() {
  console.log('\n' + '='.repeat(70))
  console.log('  T4: SCORE BUCKET CALIBRATION (last 90 days)')
  console.log('  Higher buckets should have higher hit rates')
  console.log('='.repeat(70))

  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  const rows = await fetchAll('prop_grades', 'confidence_score, hit', q =>
    q.not('hit', 'is', null).gte('game_date', cutoff)
  )

  const buckets = new Map<string, { hits: number; total: number }>()
  for (const r of rows) {
    const s = r.confidence_score ?? 0
    const bucket = s >= 80 ? '80+' : s >= 75 ? '75-79' : s >= 70 ? '70-74' : s >= 65 ? '65-69'
      : s >= 60 ? '60-64' : s >= 55 ? '55-59' : s >= 50 ? '50-54' : '<50'
    if (!buckets.has(bucket)) buckets.set(bucket, { hits: 0, total: 0 })
    const t = buckets.get(bucket)!
    t.total++
    if (r.hit) t.hits++
  }

  const order = ['<50', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80+']
  const tableRows = order
    .filter(b => buckets.has(b))
    .map(b => {
      const v = buckets.get(b)!
      return [b, v.total, v.hits, (v.hits / v.total).toFixed(4)]
    })

  printTable(['bucket', 'total', 'hits', 'hit_rate'], tableRows)
}

// ─── T5: Star Bonus Effectiveness ───────────────────────────────────────────
async function runT5() {
  console.log('\n' + '='.repeat(70))
  console.log('  T5: STAR BONUS EFFECTIVENESS (last 90 days, LOCK/PLAY OVER)')
  console.log('  Requires join to prop_history for confidence_reason')
  console.log('='.repeat(70))

  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)

  // Fetch prop_grades (LOCK/PLAY, over, graded)
  const grades = await fetchAll('prop_grades', 'player_name, stat_type, direction, game_date, confidence_label, confidence_score, hit', q =>
    q.not('hit', 'is', null).in('confidence_label', ['LOCK', 'PLAY']).eq('direction', 'over').gte('game_date', cutoff)
  )

  // Fetch prop_history for confidence_reason
  const history = await fetchAll('prop_history', 'player_name, stat_type, direction, game_date, confidence_reason', q =>
    q.not('confidence_reason', 'is', null).gte('game_date', cutoff)
  )

  // Build reason lookup
  const reasonMap = new Map<string, string>()
  for (const h of history) {
    const key = `${h.player_name}|${h.stat_type}|${h.direction}|${h.game_date}`
    reasonMap.set(key, h.confidence_reason)
  }

  const tally = new Map<string, { hits: number; total: number; scoreSum: number }>()
  for (const g of grades) {
    const key = `${g.player_name}|${g.stat_type}|${g.direction}|${g.game_date}`
    const reason = reasonMap.get(key) ?? ''
    const group = reason.toLowerCase().includes('star') ? 'star_bonus' : 'no_star_bonus'
    const tKey = `${group}|${g.confidence_label}`
    if (!tally.has(tKey)) tally.set(tKey, { hits: 0, total: 0, scoreSum: 0 })
    const t = tally.get(tKey)!
    t.total++
    t.scoreSum += g.confidence_score ?? 0
    if (g.hit) t.hits++
  }

  const tableRows = [...tally.entries()]
    .map(([k, v]) => {
      const [group, label] = k.split('|')
      return [group, label, v.total, v.hits, (v.hits / v.total).toFixed(4), (v.scoreSum / v.total).toFixed(1)]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])))

  printTable(['group', 'label', 'total', 'hits', 'hit_rate', 'avg_score'], tableRows)
}

// ─── T6: Parlay Correlation ─────────────────────────────────────────────────
async function runT6() {
  console.log('\n' + '='.repeat(70))
  console.log('  T6: PARLAY CORRELATION (last 90 days)')
  console.log('  If actual_hit_rate << expected, there is hidden correlation')
  console.log('='.repeat(70))

  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  const rows = await fetchAll('curated_parlays', 'parlay_type, result, est_multiplier, superseded', q =>
    q.not('result', 'is', null).gte('game_date', cutoff)
  )

  // Filter non-superseded
  const filtered = rows.filter(r => !r.superseded)

  const tally = new Map<string, { hits: number; total: number; multSum: number }>()
  for (const r of filtered) {
    if (!tally.has(r.parlay_type)) tally.set(r.parlay_type, { hits: 0, total: 0, multSum: 0 })
    const t = tally.get(r.parlay_type)!
    t.total++
    t.multSum += r.est_multiplier ?? 0
    if (r.result === 'hit') t.hits++
  }

  const tableRows = [...tally.entries()]
    .map(([type, v]) => [type, v.total, v.hits, (v.hits / v.total).toFixed(4), (v.multSum / v.total).toFixed(2)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  printTable(['parlay_type', 'total', 'hits', 'actual_hit_rate', 'avg_multiplier'], tableRows)
}

// ─── T7: Line Movement Signal ───────────────────────────────────────────────
async function runT7() {
  console.log('\n' + '='.repeat(70))
  console.log('  T7: LINE MOVEMENT SIGNAL (last 90 days, LOCK/PLAY)')
  console.log('  confirming should beat counter if signal is correct')
  console.log('='.repeat(70))

  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)

  const grades = await fetchAll('prop_grades', 'player_name, stat_type, direction, game_date, confidence_label, hit', q =>
    q.not('hit', 'is', null).in('confidence_label', ['LOCK', 'PLAY']).gte('game_date', cutoff)
  )

  const history = await fetchAll('prop_history', 'player_name, stat_type, direction, game_date, confidence_reason', q =>
    q.not('confidence_reason', 'is', null).gte('game_date', cutoff)
  )

  const reasonMap = new Map<string, string>()
  for (const h of history) {
    const key = `${h.player_name}|${h.stat_type}|${h.direction}|${h.game_date}`
    reasonMap.set(key, h.confidence_reason)
  }

  const tally = new Map<string, { hits: number; total: number }>()
  for (const g of grades) {
    const key = `${g.player_name}|${g.stat_type}|${g.direction}|${g.game_date}`
    const reason = reasonMap.get(key) ?? ''
    const movement = reason.includes('lineMov:+') ? 'confirming'
      : reason.includes('lineMov:-') ? 'counter'
      : 'no_movement'
    if (!tally.has(movement)) tally.set(movement, { hits: 0, total: 0 })
    const t = tally.get(movement)!
    t.total++
    if (g.hit) t.hits++
  }

  const tableRows = [...tally.entries()]
    .map(([mov, v]) => [mov, v.total, v.hits, (v.hits / v.total).toFixed(4)])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  printTable(['movement', 'total', 'hits', 'hit_rate'], tableRows)
}

// ─── T1: Held-Out Weight Validation ─────────────────────────────────────────
async function runT1() {
  console.log('\n' + '='.repeat(70))
  console.log('  T1: HELD-OUT WEIGHT VALIDATION (80/20 time split)')
  console.log('  If LOCK hit rate drops >5pp on held-out set, weights are overfit')
  console.log('='.repeat(70))

  // Get all graded dates
  const allGrades = await fetchAll('prop_grades', 'game_date, stat_type, confidence_label, hit', q =>
    q.not('hit', 'is', null).order('game_date', { ascending: true })
  )

  const splitIdx = Math.floor(allGrades.length * 0.80)
  const splitDate = allGrades[splitIdx]?.game_date
  console.log(`  Split date: ${splitDate} (${splitIdx} train / ${allGrades.length - splitIdx} test)`)

  // Full dataset stats
  const fullTally = new Map<string, { hits: number; total: number }>()
  const testTally = new Map<string, { hits: number; total: number }>()

  for (let i = 0; i < allGrades.length; i++) {
    const g = allGrades[i]
    const key = `${g.stat_type}|${g.confidence_label}`

    if (!fullTally.has(key)) fullTally.set(key, { hits: 0, total: 0 })
    fullTally.get(key)!.total++
    if (g.hit) fullTally.get(key)!.hits++

    if (i >= splitIdx) {
      if (!testTally.has(key)) testTally.set(key, { hits: 0, total: 0 })
      testTally.get(key)!.total++
      if (g.hit) testTally.get(key)!.hits++
    }
  }

  const tableRows: any[][] = []
  for (const [key, full] of fullTally) {
    const test = testTally.get(key)
    if (!test || test.total < 5) continue
    const fullRate = full.hits / full.total
    const testRate = test.hits / test.total
    const delta = testRate - fullRate
    const flag = Math.abs(delta) > 0.05 ? (delta < 0 ? ' <<<< OVERFIT?' : ' <<<< UNDERFIT?') : ''
    const [stat, label] = key.split('|')
    tableRows.push([stat, label, full.total, (fullRate).toFixed(4), test.total, (testRate).toFixed(4), (delta * 100).toFixed(1) + 'pp' + flag])
  }

  tableRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])))
  printTable(['stat', 'label', 'full_n', 'full_hr', 'test_n', 'test_hr', 'delta'], tableRows)
}

// ─── T8: Freshness Step Function ────────────────────────────────────────────
async function runT8() {
  console.log('\n' + '='.repeat(70))
  console.log('  T8: FRESHNESS STEP FUNCTION (last 120 days)')
  console.log('  Hit rate by days_since_last_game — smooth = replace step function')
  console.log('='.repeat(70))

  const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)

  const grades = await fetchAll('prop_grades', 'player_name, game_date, hit, confidence_score', q =>
    q.not('hit', 'is', null).gte('game_date', cutoff)
  )

  const logs = await fetchAll('player_game_logs', 'player_name, game_date', q =>
    q.order('game_date', { ascending: false })
  )

  // Build last-game-before map per player per date
  const logsByPlayer = new Map<string, string[]>()
  for (const l of logs) {
    if (!logsByPlayer.has(l.player_name)) logsByPlayer.set(l.player_name, [])
    logsByPlayer.get(l.player_name)!.push(l.game_date)
  }
  // Sort descending
  for (const dates of logsByPlayer.values()) dates.sort((a: string, b: string) => b.localeCompare(a))

  const buckets = new Map<number, { hits: number; total: number }>()

  for (const g of grades) {
    const playerLogs = logsByPlayer.get(g.player_name)
    if (!playerLogs) continue
    // Find most recent game before this grade date
    const gradeDate = g.game_date
    let lastGame: string | null = null
    for (const d of playerLogs) {
      if (d < gradeDate) { lastGame = d; break }
    }
    if (!lastGame) continue

    const gap = Math.round((new Date(gradeDate).getTime() - new Date(lastGame).getTime()) / 86400000)
    if (gap < 0 || gap > 30) continue

    if (!buckets.has(gap)) buckets.set(gap, { hits: 0, total: 0 })
    const b = buckets.get(gap)!
    b.total++
    if (g.hit) b.hits++
  }

  const tableRows = [...buckets.entries()]
    .filter(([_, v]) => v.total >= 10)
    .sort((a, b) => a[0] - b[0])
    .map(([gap, v]) => {
      const rate = (v.hits / v.total).toFixed(4)
      // Mark current step function boundaries
      const marker = gap === 7 ? ' | 1.00→0.88 boundary' : gap === 14 ? ' | 0.88→0.72 boundary' : gap === 21 ? ' | 0.72→0.55 boundary' : ''
      return [gap, v.total, v.hits, rate + marker]
    })

  printTable(['days_gap', 'total', 'hits', 'hit_rate'], tableRows)
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('Running all research queries against Supabase...\n')
  await runT3()
  await runT4()
  await runT5()
  await runT6()
  await runT7()
  await runT1()
  await runT8()
  console.log('\n\nDone.')
}

main().catch(console.error)
