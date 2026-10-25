// /api/synthetic/calibrate
//
// Calibrates synthetic prop lines so their OVER hit rate matches real sportsbook lines.
//
// Problem: synthetic lines use L10_avg × MEDIAN_RATIO, producing ~40% OVER hit rate
// vs ~47% on real lines. Lines are set too high — especially for high-variance stats.
//
// Approach: for each stat type, scan multipliers 0.50–1.10 (step 0.001) and compute
// OVER hit rate WITH half-point rounding applied (since real lines are always 0.5 multiples).
// Pick the multiplier whose rounded hit rate is closest to the per-stat real baseline.
//
// NOTE: blocks and steals are excluded — they are high-variance discrete stats where
// L10-average-based lines cannot be calibrated reliably. Real sportsbook props are used
// exclusively for those two stat types. Synthetic blocks/steals rows should be deleted.
//
// GET /api/synthetic/calibrate?apply=true
//   apply — if true, update rows in Supabase (default: false = dry run)

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'

export const maxDuration = 120

// blocks and steals excluded — real props only for those stats (discrete step-function issue)
const STAT_TYPES = ['points', 'rebounds', 'assists', 'pra', 'three_pointers']

const STAT_COL: Record<string, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  pra:            'pra',
  three_pointers: 'fg3m',
}

// Per-stat OVER hit rate targets derived from real sportsbook lines backtest
// (mode=real, OVER direction, all confidence tiers combined)
const REAL_HIT_RATE: Record<string, number> = {
  points:         0.471,
  rebounds:       0.459,
  assists:        0.468,
  pra:            0.474,
  three_pointers: 0.462,
}

// Current MEDIAN_RATIO values from generate/route.ts
const CURRENT_RATIO: Record<string, number> = {
  points:         1.001,
  rebounds:       0.978,
  assists:        0.932,
  pra:            1.013,
  three_pointers: 0.704,
}

/** Round to nearest 0.5 — same as real sportsbook lines */
function roundHalf(v: number): number {
  return Math.round(v * 2) / 2
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url   = new URL(req.url)
  const apply = url.searchParams.get('apply') === 'true'

  // ── 1. Load all synthetic OVER props ──────────────────────────────────────
  interface SynthRow {
    id:          string
    player_name: string
    stat_type:   string
    line:        number
    game_date:   string
  }

  const synthRows: SynthRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('synthetic_prop_lines')
        .select('id, player_name, stat_type, line, game_date')
        .eq('direction', 'over')
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      synthRows.push(...(page as SynthRow[]))
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[calibrate] ${synthRows.length} synthetic OVER props loaded`)

  // ── 2. Load actual game log outcomes ────────────────────────────────────
  const playerNames = [...new Set(synthRows.map((r) => r.player_name))]

  interface LogRow {
    player_name: string
    game_date:   string
    points: number; rebounds: number; assists: number; pra: number
    blocks: number; steals:  number; fg3m:    number; minutes: number
  }

  const logMap = new Map<string, LogRow>()
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name,game_date,points,rebounds,assists,pra,blocks,steals,fg3m,minutes')
        .in('player_name', playerNames)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page as LogRow[]) {
        logMap.set(`${row.player_name}|${row.game_date}`, row)
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }
  console.log(`[calibrate] ${logMap.size} game log rows loaded`)

  // ── 3. Build per-stat (line, actual) pairs ───────────────────────────────
  const statData: Record<string, Array<{ id: string; line: number; actual: number }>> = {}
  for (const st of STAT_TYPES) statData[st] = []

  for (const row of synthRows) {
    const col    = STAT_COL[row.stat_type]
    const log    = logMap.get(`${row.player_name}|${row.game_date}`)
    if (!log || !col || log.minutes < 5) continue
    const actual = (log as unknown as Record<string, number>)[col] as number
    if (actual == null) continue
    statData[row.stat_type]?.push({ id: row.id, line: row.line, actual })
  }

  // ── 4. For each stat: scan multipliers with rounding, pick best m ────────
  // Apply half-point rounding to the adjusted line before computing hit rate,
  // so the result reflects what would actually happen after re-generating lines.
  function hitRateRounded(
    pairs: Array<{ line: number; actual: number }>,
    m: number,
  ): number {
    if (pairs.length === 0) return 0
    const hits = pairs.filter((p) => p.actual > roundHalf(p.line * m)).length
    return hits / pairs.length
  }

  const results: Record<string, {
    statType:       string
    propsWithData:  number
    currentHitRate: number
    targetHitRate:  number
    bestM:          number
    achievedHitRate: number
    oldRatio:       number
    newRatio:       number
    linesWillChange: number
  }> = {}

  for (const st of STAT_TYPES) {
    const pairs  = statData[st]
    const target = REAL_HIT_RATE[st] ?? 0.471

    if (pairs.length < 50) {
      results[st] = { statType: st, propsWithData: pairs.length, currentHitRate: 0,
        targetHitRate: target, bestM: 1.0, achievedHitRate: 0,
        oldRatio: CURRENT_RATIO[st] ?? 1.0, newRatio: CURRENT_RATIO[st] ?? 1.0,
        linesWillChange: 0 }
      continue
    }

    const currentHR = hitRateRounded(pairs, 1.0)

    // Scan m from 0.50 to 1.10 in steps of 0.001 — coarse then refine
    let bestM    = 1.0
    let bestDiff = Math.abs(currentHR - target)

    for (let mi = 500; mi <= 1100; mi++) {
      const m  = mi / 1000
      const hr = hitRateRounded(pairs, m)
      const diff = Math.abs(hr - target)
      if (diff < bestDiff) { bestDiff = diff; bestM = m }
    }

    // Count how many lines will actually change when rounded
    const linesWillChange = pairs.filter((p) => {
      const newLine = roundHalf(p.line * bestM)
      return newLine !== p.line && newLine >= 0.5
    }).length

    results[st] = {
      statType:        st,
      propsWithData:   pairs.length,
      currentHitRate:  Math.round(currentHR * 1000) / 10,
      targetHitRate:   Math.round(target * 1000) / 10,
      bestM:           bestM,
      achievedHitRate: Math.round(hitRateRounded(pairs, bestM) * 1000) / 10,
      oldRatio:        CURRENT_RATIO[st] ?? 1.0,
      newRatio:        Math.round((CURRENT_RATIO[st] ?? 1.0) * bestM * 1000) / 1000,
      linesWillChange,
    }
  }

  // ── 5. Optionally apply: update synthetic_prop_lines ────────────────────
  // Use .update({ line }).in('id', [...]) grouped by new line value.
  // This sends a PATCH (not INSERT), so only the line column changes.
  let rowsUpdated = 0
  if (apply) {
    async function applyUpdates(
      updates: Array<{ id: string; line: number }>,
      label: string,
    ) {
      // Group by new line value to batch efficiently
      const byNewLine = new Map<number, string[]>()
      for (const u of updates) {
        if (!byNewLine.has(u.line)) byNewLine.set(u.line, [])
        byNewLine.get(u.line)!.push(u.id)
      }
      const BATCH = 800  // PostgREST IN clause limit
      for (const [newLine, ids] of byNewLine) {
        for (let i = 0; i < ids.length; i += BATCH) {
          const batch = ids.slice(i, i + BATCH)
          const { error, count } = await supabase
            .from('synthetic_prop_lines')
            .update({ line: newLine })
            .in('id', batch)
          if (!error) rowsUpdated += count ?? batch.length
          else console.error(`[calibrate] update error (${label} line=${newLine}):`, error.message)
        }
      }
    }

    for (const st of STAT_TYPES) {
      const r = results[st]
      if (!r || r.linesWillChange === 0) continue
      const m = r.bestM

      // OVER rows — IDs already in statData
      const overUpdates = statData[st]
        .map((p) => {
          const newLine = roundHalf(p.line * m)
          return (newLine !== p.line && newLine >= 0.5) ? { id: p.id, line: newLine } : null
        })
        .filter(Boolean) as Array<{ id: string; line: number }>
      await applyUpdates(overUpdates, `${st}/over`)

      // UNDER rows — same multiplier, load by stat_type + direction
      const underAll: Array<{ id: string; line: number }> = []
      let from = 0
      while (true) {
        const { data: page } = await supabase
          .from('synthetic_prop_lines')
          .select('id, line')
          .eq('stat_type', st)
          .eq('direction', 'under')
          .range(from, from + 999)
        if (!page || page.length === 0) break
        for (const row of page as { id: string; line: number }[]) {
          const newLine = roundHalf(row.line * m)
          if (newLine !== row.line && newLine >= 0.5) underAll.push({ id: row.id, line: newLine })
        }
        if (page.length < 1000) break
        from += 1000
      }
      await applyUpdates(underAll, `${st}/under`)
    }
    console.log(`[calibrate] Updated ${rowsUpdated} rows`)
  }

  // ── 6. New MEDIAN_RATIO constants for generate/route.ts ─────────────────
  const newRatioCode = STAT_TYPES.map((st) => {
    const val = results[st]?.newRatio ?? CURRENT_RATIO[st] ?? 1.0
    return `  ${st.padEnd(16)}: ${val.toFixed(3)},`
  }).join('\n')

  return NextResponse.json({
    apply,
    rowsUpdated: apply ? rowsUpdated : 0,
    perStat: Object.values(results).map((r) => ({
      stat:            r.statType,
      propsWithData:   r.propsWithData,
      currentHitRate:  `${r.currentHitRate}%`,
      target:          `${r.targetHitRate}%`,
      achievedHitRate: `${r.achievedHitRate}%`,
      multiplier:      r.bestM,
      oldRatio:        r.oldRatio,
      newRatio:        r.newRatio,
      linesWillChange: r.linesWillChange,
    })),
    newMedianRatioConstants:
      `const MEDIAN_RATIO: Record<string, number> = {\n${newRatioCode}\n}`,
    note: apply
      ? `${rowsUpdated} rows updated. Copy newMedianRatioConstants into generate/route.ts.`
      : 'Dry run — pass apply=true to update Supabase.',
  })
}
