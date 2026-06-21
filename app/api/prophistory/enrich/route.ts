// /api/prophistory/enrich
//
// Enriches historical prop lines from `historical_prop_lines` with the current
// confidence model (see lib/confidence.ts — v11.0 at the time of last touch)
// and saves the scored props to `prop_history`.
//
// Uses strictly prior game logs (no lookahead bias) — same guarantee as the backtest.
// IDs are deterministic SHA-256 hashes of (player|stat|direction|game_date) so
// repeated calls are idempotent via the (id, game_date) upsert conflict key.
//
// GET ?date=YYYY-MM-DD                     — single date
//     ?start=YYYY-MM-DD&end=YYYY-MM-DD     — date range
//     (no params)                          — all available dates in historical_prop_lines
//
// After running this, call:
//   GET /api/grade?date=YYYY-MM-DD         — grade enriched props against game logs
//   GET /api/results?force=true            — recompute hit-rate summary stats

import { NextResponse }  from 'next/server'
import { createHash }    from 'crypto'
import { supabase }      from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { scoreProps, type PlayerLineBias, type OpponentStatLeak, type ScoringContext } from '@/lib/confidence'
import type { Prop, StatType } from '@/types'

export const maxDuration = 120

// Deterministic UUID-formatted ID derived from a string key (SHA-256, UUID v4 shape)
function deterministicId(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-')
}

interface HistPropRow {
  player_name:   string
  stat_type:     string
  direction:     string
  line:          number
  game_date:     string
  commence_time: string | null
  odds:          number | null
  home_team:     string | null
  away_team:     string | null
  sportsbook:    string | null
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

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const url        = new URL(req.url)
  const dateParam  = url.searchParams.get('date')
  const startParam = url.searchParams.get('start')
  const endParam   = url.searchParams.get('end')

  try {
    // ── 1. Load prop lines — historical_prop_lines + synthetic_prop_lines ────────
    // historical: Feb 4 2026 onward (real sportsbook lines + odds)
    // synthetic:  Dec 1 2025 → Feb 3 2026 (model-generated lines, no real odds)
    const propRows: HistPropRow[] = []

    async function loadHistorical() {
      let from = 0
      const PAGE = 1000
      while (true) {
        let q = supabase
          .from('historical_prop_lines')
          .select('player_name, stat_type, direction, line, game_date, commence_time, odds, home_team, away_team, sportsbook')
          .order('game_date', { ascending: true })
        if (dateParam)  q = q.eq('game_date', dateParam)
        if (startParam) q = q.gte('game_date', startParam)
        if (endParam)   q = q.lte('game_date', endParam)
        const { data: page, error } = await q.range(from, from + PAGE - 1)
        if (error) throw new Error(`historical_prop_lines read: ${error.message}`)
        if (!page || page.length === 0) break
        for (const row of page) propRows.push(row as HistPropRow)
        if (page.length < PAGE) break
        from += PAGE
      }
    }

    async function loadSynthetic() {
      // synthetic_prop_lines has no odds/sportsbook — fill those with null
      let from = 0
      const PAGE = 1000
      while (true) {
        let q = supabase
          .from('synthetic_prop_lines')
          .select('player_name, stat_type, direction, line, game_date, commence_time, home_team, away_team')
          .order('game_date', { ascending: true })
        if (dateParam)  q = q.eq('game_date', dateParam)
        if (startParam) q = q.gte('game_date', startParam)
        if (endParam)   q = q.lte('game_date', endParam)
        const { data: page, error } = await q.range(from, from + PAGE - 1)
        if (error) { console.warn(`[prophistory/enrich] synthetic read: ${error.message}`); break }
        if (!page || page.length === 0) break
        for (const row of page) {
          propRows.push({ ...row as HistPropRow, odds: null, sportsbook: 'synthetic' })
        }
        if (page.length < PAGE) break
        from += PAGE
      }
    }

    await loadHistorical()
    await loadSynthetic()

    if (propRows.length === 0) {
      return NextResponse.json({ message: 'No props found for the requested date range', enriched: 0 })
    }

    // ── 2. Deduplicate — one OVER per (player, stat, game_date) ───────────────
    // Prefer DraftKings; fallback to any row with odds; else first seen.
    const propMap = new Map<string, HistPropRow>()
    for (const p of propRows) {
      if (p.direction !== 'over') continue
      const key = `${p.player_name}|${p.stat_type}|${p.game_date}`
      const existing = propMap.get(key)
      if (!existing) {
        propMap.set(key, p)
      } else if (p.sportsbook === 'draftkings') {
        propMap.set(key, p)
      } else if (p.odds != null && existing.odds == null) {
        propMap.set(key, p)
      }
    }
    const dedupedProps = [...propMap.values()]
    console.log(`[prophistory/enrich] ${propRows.length} raw rows → ${dedupedProps.length} unique OVER props`)

    if (dedupedProps.length === 0) {
      return NextResponse.json({ message: 'No OVER props after dedup', enriched: 0 })
    }

    // ── 3. Load game logs for all relevant players ─────────────────────────────
    const playerSet = [...new Set(dedupedProps.map((p) => p.player_name))]
    const allLogs: GameLogRow[] = []
    {
      let from = 0
      const PAGE = 1000
      while (true) {
        const { data: page, error } = await supabase
          .from('player_game_logs')
          .select('player_name, game_date, matchup, is_home, points, rebounds, assists, pra, blocks, steals, fg3m, minutes')
          .in('player_name', playerSet)
          .order('game_date', { ascending: false })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(`player_game_logs read: ${error.message}`)
        if (!page || page.length === 0) break
        for (const row of page) allLogs.push(row as GameLogRow)
        if (page.length < PAGE) break
        from += PAGE
      }
    }
    console.log(`[prophistory/enrich] ${allLogs.length} game log rows for ${playerSet.length} players`)

    // ── 4. Load player bias + opponent leaks ──────────────────────────────────
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

    // Index: player → logs (already sorted descending by query)
    const logsByPlayer = new Map<string, GameLogRow[]>()
    for (const log of allLogs) {
      if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
      logsByPlayer.get(log.player_name)!.push(log)
    }

    // Index: player|date → log row (for opponent abbreviation lookup)
    const logByPlayerDate = new Map<string, GameLogRow>()
    for (const log of allLogs) {
      logByPlayerDate.set(`${log.player_name}|${log.game_date}`, log)
    }

    // ── 5. Score each prop ────────────────────────────────────────────────────
    const historyRows: Record<string, unknown>[] = []
    let skipped = 0
    const now = new Date().toISOString()

    for (const prop of dedupedProps) {
      const allPlayerLogs = logsByPlayer.get(prop.player_name) ?? []
      // Strictly prior game logs — no lookahead bias
      const priorLogs = allPlayerLogs.filter((g) => g.game_date < prop.game_date)
      if (priorLogs.length < 3) { skipped++; continue }

      // Derive opponent abbreviation from the actual game log matchup (just identifies the team)
      const gameLog = logByPlayerDate.get(`${prop.player_name}|${prop.game_date}`)
      let opponentAbbr: string | null = null
      if (gameLog) {
        const parts = gameLog.matchup.split('@')
        if (parts.length === 2) {
          opponentAbbr = gameLog.is_home ? parts[0].trim() : parts[1].trim()
        }
      }

      const propObj: Prop = {
        id:            deterministicId(`${prop.player_name}|${prop.stat_type}|over|${prop.game_date}`),
        player_id:     0,
        player_name:   prop.player_name,
        team:          '',
        opponent:      opponentAbbr ?? '',
        game_id:       '',
        stat_type:     prop.stat_type as StatType,
        direction:     'over',
        line:          prop.line,
        odds:          prop.odds ?? undefined,
        commence_time: prop.commence_time ?? `${prop.game_date}T23:30:00+00:00`,
      }

      const ctx: ScoringContext = {
        playerBias:   biasMap.get(`${prop.player_name}|${prop.stat_type}`) ?? null,
        opponentLeak: opponentAbbr ? (leakMap.get(`${opponentAbbr}|${prop.stat_type}`) ?? null) : null,
        opponentAbbr,
      }

      const scored = scoreProps(propObj, priorLogs, null, ctx)

      historyRows.push({
        id:                scored.id,
        player_name:       prop.player_name,
        stat_type:         prop.stat_type,
        direction:         'over',
        line:              prop.line,
        odds:              prop.odds ?? null,
        confidence_score:  scored.confidence_score,
        confidence_label:  scored.confidence_label,
        risk_tier:         scored.risk_tier,
        confidence_reason: scored.confidence_reason,
        commence_time:     prop.commence_time ?? null,
        home_team:         prop.home_team ?? null,
        away_team:         prop.away_team ?? null,
        game_id:           '',
        cached_at:         now,
        game_date:         prop.game_date,
      })
    }

    // ── 6. Upsert to prop_history ─────────────────────────────────────────────
    const BATCH = 500
    let enriched = 0
    const errors: string[] = []

    for (let i = 0; i < historyRows.length; i += BATCH) {
      const { error } = await supabase
        .from('prop_history')
        .upsert(historyRows.slice(i, i + BATCH), { onConflict: 'id,game_date' })
      if (error) {
        errors.push(error.message)
        console.error('[prophistory/enrich] upsert error:', error.message)
      } else {
        enriched += historyRows.slice(i, i + BATCH).length
      }
    }

    const dates = [...new Set(historyRows.map((r) => r.game_date as string))].sort()
    const byDate: Record<string, number> = {}
    for (const r of historyRows) {
      const d = r.game_date as string
      byDate[d] = (byDate[d] ?? 0) + 1
    }

    console.log(`[prophistory/enrich] Enriched ${enriched} props for ${dates.join(', ')}`)

    return NextResponse.json({
      enriched,
      skipped,
      dates,
      byDate,
      ...(errors.length > 0 && { errors }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[prophistory/enrich]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
