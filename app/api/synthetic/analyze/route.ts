// /api/synthetic/analyze
//
// Analyzes historical_prop_lines to derive the ratio between sportsbook lines
// and player rolling averages. This ratio is used to generate synthetic prop
// lines for dates before the real historical data begins (Dec 1 – Feb 3, 2026).
//
// GET /api/synthetic/analyze
//   → returns per-stat regression stats: { statType, sampleSize, medianRatio, p25, p75 }
//
// The key insight: sportsbooks set lines close to a player's L10 average.
// We compute line / L10_avg for each (player, stat_type, game_date) and report
// the distribution so the generate endpoint can apply it.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'

export const maxDuration = 60

// Stat types we care about for synthetic line generation
const STAT_TYPES = ['points', 'rebounds', 'assists', 'pra', 'blocks', 'steals', 'three_pointers']

// Map historical_prop_lines stat_type → player_game_logs column
const STAT_COLUMN: Record<string, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  pra:            'pra',
  blocks:         'blocks',
  steals:         'steals',
  three_pointers: 'fg3m',
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  // ── 1. Sample historical_prop_lines (one line per player/stat/date) ──────────
  // We only need one direction since line is the same for over and under
  const propSample: Array<{
    player_name: string
    stat_type: string
    line: number
    game_date: string
  }> = []

  for (const statType of STAT_TYPES) {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('historical_prop_lines')
        .select('player_name, stat_type, line, game_date')
        .eq('stat_type', statType)
        .eq('direction', 'over')
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) {
        propSample.push({
          player_name: row.player_name as string,
          stat_type:   row.stat_type as string,
          line:        row.line as number,
          game_date:   row.game_date as string,
        })
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  console.log(`[synthetic/analyze] ${propSample.length} prop lines sampled`)

  // ── 2. Load all game logs for players in sample ────────────────────────────
  const playerSet = [...new Set(propSample.map((p) => p.player_name))]

  // Map player_name → sorted game logs (descending by date)
  const logsByPlayer = new Map<string, Array<{ game_date: string; [k: string]: unknown }>>()

  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, points, rebounds, assists, pra, blocks, steals, fg3m')
        // fg3m = three_pointers made — maps to three_pointers stat_type in props
        .in('player_name', playerSet)
        .order('game_date', { ascending: false })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) {
        const name = row.player_name as string
        if (!logsByPlayer.has(name)) logsByPlayer.set(name, [])
        logsByPlayer.get(name)!.push(row as unknown as { game_date: string; [k: string]: unknown })
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // ── 3. For each prop line, compute L10 avg at that date and ratio ───────────
  const ratiosByStatType: Record<string, number[]> = {}
  for (const st of STAT_TYPES) ratiosByStatType[st] = []

  for (const prop of propSample) {
    const col = STAT_COLUMN[prop.stat_type]
    if (!col) continue
    const logs = logsByPlayer.get(prop.player_name)
    if (!logs) continue

    // Games BEFORE this game date (prior performance only)
    const prior = logs.filter((g) => (g.game_date as string) < prop.game_date)
    const l10 = prior.slice(0, 10)
    if (l10.length < 5) continue // need at least 5 games for reliable average

    const avg = l10.reduce((s, g) => s + (g[col] as number), 0) / l10.length
    if (avg < 1.0) continue // skip near-zero averages (e.g. 0-block players)

    const ratio = prop.line / avg
    // Sanity filter: exclude extreme outliers (ratio should be 0.5–2.0 for sane lines)
    if (ratio >= 0.5 && ratio <= 2.0) {
      ratiosByStatType[prop.stat_type].push(ratio)
    }
  }

  // ── 4. Compute distribution stats per stat type ────────────────────────────
  function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 1.0
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * p)
    return Math.round(sorted[Math.min(idx, sorted.length - 1)] * 1000) / 1000
  }
  function mean(arr: number[]): number {
    if (arr.length === 0) return 1.0
    return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 1000) / 1000
  }

  const stats = STAT_TYPES.map((st) => {
    const ratios = ratiosByStatType[st]
    return {
      statType:    st,
      sampleSize:  ratios.length,
      mean:        mean(ratios),
      median:      percentile(ratios, 0.5),
      p25:         percentile(ratios, 0.25),
      p75:         percentile(ratios, 0.75),
    }
  })

  return NextResponse.json({
    message: 'Analysis complete — use median ratio as the line multiplier in /api/synthetic/generate',
    totalPropLines: propSample.length,
    stats,
  })
}
