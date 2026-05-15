// /api/backtest/parlays
//
// Backtests daily parlay construction across multiple strategies using
// historical prop data (prop_grades + player_game_logs for game keys).
//
// For each game date, constructs the best N-leg parlay by picking the
// highest-confidence LOCK/PLAY OVER props with max 1 prop per game and
// max 1 prop per player, then checks if all legs hit.
//
// Strategies tested (legs × market filter × tier filter):
//   - 3-leg and 4-leg
//   - All markets | No steals/blocks | PTS/REB/AST/PRA | PTS/REB/AST | PTS/REB | PTS/3PM/REB
//   - LOCK+PLAY | PLAY-only | LOCK+PLAY+top-LEAN
//
// Payout: cross-game parlay (no SGP discount). Uses actual odds from
// prop_history where available; falls back to -115 default.
//
// Profit: stake = 5 units/day
//   Hit:  +5 × (product of decimal odds) − 5
//   Miss: −5

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { ev as computeEv } from '@/lib/ev'

export const maxDuration = 120

const STAKE = 5  // units per parlay

// Stat column mapping: prop stat_type → game_log column
const STAT_COL: Record<string, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  pra:            'pra',
  blocks:         'blocks',
  steals:         'steals',
  three_pointers: 'fg3m',
}

// Market filter presets
const MARKET_FILTERS: Record<string, string[]> = {
  all:         ['points','rebounds','assists','pra','steals','blocks','three_pointers'],
  no_volatile: ['points','rebounds','assists','pra','three_pointers'],
  major:       ['points','rebounds','assists','pra'],
  pts_reb_ast: ['points','rebounds','assists'],
  pts_reb:     ['points','rebounds'],
  pts_reb_3pm: ['points','rebounds','three_pointers'],
}

interface GradeRow {
  game_date:        string
  player_name:      string
  stat_type:        string
  line:             number
  direction:        string
  confidence_label: string
  confidence_score: number
  hit:              boolean | null
}

interface HistRow {
  game_date:   string
  player_name: string
  stat_type:   string
  direction:   string
  line:        number
  odds:        number | null
  home_team:   string | null
  away_team:   string | null
}

interface LogRow {
  player_name: string
  game_date:   string
  matchup:     string
  is_home:     boolean
}

function toDecimal(odds: number | null): number {
  if (odds == null) return 100 / 130 + 1  // default -130 (conservative avg prop odds)
  if (odds > 0) return odds / 100 + 1
  return 100 / Math.abs(odds) + 1
}

interface Strategy {
  id:       string
  label:    string
  legs:     3 | 4
  markets:  keyof typeof MARKET_FILTERS
  tiers:    string[]  // confidence labels to include
}

const STRATEGIES: Strategy[] = [
  { id: 'all_3',         label: 'All markets · 3-leg · LOCK+PLAY',         legs: 3, markets: 'all',         tiers: ['LOCK','PLAY'] },
  { id: 'all_4',         label: 'All markets · 4-leg · LOCK+PLAY',         legs: 4, markets: 'all',         tiers: ['LOCK','PLAY'] },
  { id: 'no_vol_3',      label: 'No STL/BLK · 3-leg · LOCK+PLAY',         legs: 3, markets: 'no_volatile',  tiers: ['LOCK','PLAY'] },
  { id: 'no_vol_4',      label: 'No STL/BLK · 4-leg · LOCK+PLAY',         legs: 4, markets: 'no_volatile',  tiers: ['LOCK','PLAY'] },
  { id: 'major_3',       label: 'PTS/REB/AST/PRA · 3-leg · LOCK+PLAY',    legs: 3, markets: 'major',        tiers: ['LOCK','PLAY'] },
  { id: 'major_4',       label: 'PTS/REB/AST/PRA · 4-leg · LOCK+PLAY',    legs: 4, markets: 'major',        tiers: ['LOCK','PLAY'] },
  { id: 'pts_reb_ast_3', label: 'PTS/REB/AST · 3-leg · LOCK+PLAY',        legs: 3, markets: 'pts_reb_ast',  tiers: ['LOCK','PLAY'] },
  { id: 'pts_reb_ast_4', label: 'PTS/REB/AST · 4-leg · LOCK+PLAY',        legs: 4, markets: 'pts_reb_ast',  tiers: ['LOCK','PLAY'] },
  { id: 'pts_reb_3',     label: 'PTS/REB · 3-leg · LOCK+PLAY',            legs: 3, markets: 'pts_reb',      tiers: ['LOCK','PLAY'] },
  { id: 'pts_reb_3pm_3', label: 'PTS/REB/3PM · 3-leg · LOCK+PLAY',       legs: 3, markets: 'pts_reb_3pm',  tiers: ['LOCK','PLAY'] },
  { id: 'all_3_lean',    label: 'All markets · 3-leg · LOCK+PLAY+top LEAN',legs: 3, markets: 'all',         tiers: ['LOCK','PLAY','LEAN'] },
  { id: 'no_vol_3_lean', label: 'No STL/BLK · 3-leg · LOCK+PLAY+top LEAN',legs: 3, markets: 'no_volatile',  tiers: ['LOCK','PLAY','LEAN'] },
]

interface DayResult {
  date:       string
  legs:       number
  hit:        boolean | null  // null = not enough legs
  profit:     number
  legDecimal: number
  legLabels:  string[]
}

interface StrategyResult {
  id:              string
  label:           string
  played:          number
  hits:            number
  hitRate:         number | null
  avgOdds:         number
  avgProfitPerPlayedDay: number
  totalProfit:     number
  roi:             number | null  // total profit / total staked × 100
  perDate:         DayResult[]
}

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  // ── 1. Load prop_grades (confidence + hit result) ─────────────────────────
  const grades: GradeRow[] = []
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('prop_grades')
        .select('game_date, player_name, stat_type, line, direction, confidence_label, confidence_score, hit')
        .not('confidence_label', 'is', null)
        .eq('direction', 'over')
        .lt('game_date', today)
        .order('game_date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) grades.push(row as GradeRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  if (grades.length === 0) {
    return NextResponse.json({ error: 'No graded prop data found' }, { status: 400 })
  }

  // ── 2. Load prop_history for odds + game keys ─────────────────────────────
  const histMap = new Map<string, HistRow>()  // key: player|stat|date
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('prop_history')
        .select('game_date, player_name, stat_type, direction, line, odds, home_team, away_team')
        .eq('direction', 'over')
        .lt('game_date', today)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) {
        const r = row as HistRow
        histMap.set(`${r.player_name}|${r.stat_type}|${r.game_date}`, r)
      }
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // ── 3. Load game logs for matchup info (game key) ─────────────────────────
  const playerSet = [...new Set(grades.map(g => g.player_name))]
  const dateSet   = [...new Set(grades.map(g => g.game_date))]
  const logMap = new Map<string, LogRow>()  // key: player|date
  {
    let from = 0
    const PAGE = 1000
    while (true) {
      const { data: page } = await supabase
        .from('player_game_logs')
        .select('player_name, game_date, matchup, is_home')
        .in('player_name', playerSet)
        .in('game_date', dateSet)
        .range(from, from + PAGE - 1)
      if (!page || page.length === 0) break
      for (const row of page) logMap.set(`${row.player_name}|${row.game_date}`, row as LogRow)
      if (page.length < PAGE) break
      from += PAGE
    }
  }

  // ── 4. Build annotated prop list with game keys + odds ────────────────────
  interface AnnProp extends GradeRow {
    gameKey: string
    odds:    number | null
  }

  const annotated: AnnProp[] = grades.map(g => {
    const hist    = histMap.get(`${g.player_name}|${g.stat_type}|${g.game_date}`)
    const logEntry = logMap.get(`${g.player_name}|${g.game_date}`)

    // Derive game key from matchup (e.g. "LAL @ BOS") or home/away
    let gameKey = ''
    if (logEntry?.matchup) {
      // Normalize: sort the two teams alphabetically so LAL@BOS = BOS@LAL
      gameKey = logEntry.matchup.replace(/\s+/g, '').split('@').sort().join('|')
    } else if (hist?.home_team && hist?.away_team) {
      gameKey = [hist.home_team, hist.away_team].sort().join('|')
    }

    return { ...g, gameKey, odds: hist?.odds ?? null }
  })

  // Group by date
  const byDate = new Map<string, AnnProp[]>()
  for (const p of annotated) {
    if (!byDate.has(p.game_date)) byDate.set(p.game_date, [])
    byDate.get(p.game_date)!.push(p)
  }
  const sortedDates = [...byDate.keys()].sort()

  // ── 5. Run each strategy ──────────────────────────────────────────────────
  const strategyResults: StrategyResult[] = []

  for (const strategy of STRATEGIES) {
    const allowedMarkets = new Set(MARKET_FILTERS[strategy.markets])
    const allowedTiers   = new Set(strategy.tiers)
    const perDate: DayResult[] = []
    let played = 0, hits = 0, totalProfit = 0, totalDecimal = 0

    for (const date of sortedDates) {
      const dayProps = byDate.get(date) ?? []

      // Filter: tier + market + must have result.
      // Sort by EV (calibrated_prob × decimal_odds − 1) descending — mirrors
      // production's app/api/feed/generate/parlay sort change so backtest
      // simulates current behavior, not the old tier-first pre-073b000 logic.
      // Falls back to confidence_score when EV is unavailable (no odds).
      const eligible = dayProps
        .filter(p => allowedTiers.has(p.confidence_label))
        .filter(p => allowedMarkets.has(p.stat_type))
        .filter(p => p.hit !== null)
        .sort((a, b) => {
          const aEv = computeEv(a.confidence_score, a.odds) ?? -Infinity
          const bEv = computeEv(b.confidence_score, b.odds) ?? -Infinity
          if (aEv !== bEv) return bEv - aEv
          return b.confidence_score - a.confidence_score
        })

      // Greedy selection: max 1 per game, max 1 per player
      const selected: AnnProp[] = []
      const usedGames   = new Set<string>()
      const usedPlayers = new Set<string>()

      for (const prop of eligible) {
        if (selected.length >= strategy.legs) break
        if (usedPlayers.has(prop.player_name)) continue
        if (prop.gameKey && usedGames.has(prop.gameKey)) continue
        selected.push(prop)
        usedPlayers.add(prop.player_name)
        if (prop.gameKey) usedGames.add(prop.gameKey)
      }

      if (selected.length < strategy.legs) {
        perDate.push({ date, legs: selected.length, hit: null, profit: 0, legDecimal: 0, legLabels: [] })
        continue
      }

      played++
      const legDecimals  = selected.map(p => toDecimal(p.odds))
      const parlayDecimal = legDecimals.reduce((acc, d) => acc * d, 1)
      totalDecimal += parlayDecimal

      const parlayHit = selected.every(p => p.hit === true)
      if (parlayHit) hits++

      const profit = parlayHit ? STAKE * parlayDecimal - STAKE : -STAKE
      totalProfit += profit

      perDate.push({
        date,
        legs:       selected.length,
        hit:        parlayHit,
        profit:     Math.round(profit * 100) / 100,
        legDecimal: Math.round(parlayDecimal * 100) / 100,
        legLabels:  selected.map(p =>
          `${p.player_name} ${p.direction.toUpperCase()} ${p.line} ${p.stat_type} (${p.confidence_label} ${p.confidence_score})`
        ),
      })
    }

    const hitRate = played > 0 ? Math.round(hits / played * 1000) / 10 : null
    const totalStaked = played * STAKE

    strategyResults.push({
      id:                   strategy.id,
      label:                strategy.label,
      played,
      hits,
      hitRate,
      avgOdds:              played > 0 ? Math.round(totalDecimal / played * 100) / 100 : 0,
      avgProfitPerPlayedDay: played > 0 ? Math.round(totalProfit / played * 100) / 100 : 0,
      totalProfit:          Math.round(totalProfit * 100) / 100,
      roi:                  totalStaked > 0 ? Math.round(totalProfit / totalStaked * 1000) / 10 : null,
      perDate,
    })
  }

  // Sort by hit rate descending
  strategyResults.sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0))

  // ── 6. Per-market hit rate analysis ──────────────────────────────────────
  const marketStats: Record<string, { total: number; hits: number; hitRate: number | null }> = {}
  for (const stat of Object.keys(STAT_COL)) {
    const rows = annotated.filter(p => p.stat_type === stat && p.hit !== null && ['LOCK','PLAY'].includes(p.confidence_label))
    const h    = rows.filter(p => p.hit === true).length
    marketStats[stat] = {
      total:   rows.length,
      hits:    h,
      hitRate: rows.length > 0 ? Math.round(h / rows.length * 1000) / 10 : null,
    }
  }

  // Best strategy summary
  const best = strategyResults[0]

  return NextResponse.json({
    summary: {
      totalDates:   sortedDates.length,
      dateRange:    sortedDates.length > 0 ? `${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]}` : '',
      stakePerDay:  STAKE,
      totalProps:   grades.length,
    },
    marketHitRates: marketStats,
    strategies: strategyResults.map(r => ({
      id:                   r.id,
      label:                r.label,
      played:               r.played,
      hits:                 r.hits,
      hitRate:              r.hitRate,
      avgOdds:              r.avgOdds,
      avgProfitPerPlayedDay: r.avgProfitPerPlayedDay,
      totalProfit:          r.totalProfit,
      roi:                  r.roi,
    })),
    best: {
      ...best,
      perDate: best?.perDate,
    },
  })
}
