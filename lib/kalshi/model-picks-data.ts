// SERVER-ONLY loader for Kalshi model picks: today's (ET) Kalshi rungs + scored sportsbook
// lines from props and prop_alts, matched by lib/kalshi/model-picks.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { MARKET_STATS, type MarketRow } from '@/lib/kalshi/ladder'
import {
  etDayWindow, matchPicks, matchStretched, visiblePicks, type ModelPick, type ModelRung, type ScoredLine,
} from '@/lib/kalshi/model-picks'

const PAGE = 1000

// Postgres numeric can arrive as a string from PostgREST; coerce defensively.
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))

export const todayEt = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

async function loadMarkets(client: SupabaseClient, gameDate: string): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from('kalshi_markets')
      .select('ticker, stat, player, strike, game_date, away, home, yes_bid, yes_ask, first_yes_ask, volume, status, updated_at')
      .eq('game_date', gameDate).in('stat', [...MARKET_STATS])
      .order('ticker').range(from, from + PAGE - 1)
    if (error) throw new Error(`kalshi_markets: ${error.message}`)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      out.push({
        ...(r as unknown as MarketRow),
        strike: Number(r.strike),
        volume: Number(r.volume ?? 0),
        yes_bid: num(r.yes_bid),
        yes_ask: num(r.yes_ask),
        first_yes_ask: num(r.first_yes_ask),
      })
    }
    if (!data || data.length < PAGE) break
  }
  return out
}

async function loadScored(client: SupabaseClient, table: 'props' | 'prop_alts', gameDate: string): Promise<ScoredLine[]> {
  const { start, end } = etDayWindow(gameDate)
  const out: ScoredLine[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table)
      .select('player_name, stat_type, line, direction, confidence_score, confidence_label, commence_time')
      .gte('commence_time', start).lt('commence_time', end)
      .not('confidence_score', 'is', null)
      .in('confidence_label', ['LOCK', 'PLAY'])
      .order('player_name').order('stat_type').order('line').order('direction')
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      out.push({ ...(r as unknown as ScoredLine), line: Number(r.line), confidence_score: Number(r.confidence_score) })
    }
    if (!data || data.length < PAGE) break
  }
  return out
}

async function loadRungs(client: SupabaseClient, gameDate: string): Promise<ModelRung[]> {
  const out: ModelRung[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from('kalshi_model_rungs')
      .select('ticker, model_p, exact, commence_time, computed_at')
      .eq('game_date', gameDate).order('ticker').range(from, from + PAGE - 1)
    if (error) throw new Error(`kalshi_model_rungs: ${error.message}`)
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      out.push({ ...(r as unknown as ModelRung), model_p: Number(r.model_p) })
    }
    if (!data || data.length < PAGE) break
  }
  return out
}

export interface TodayPicks {
  gameDate: string
  markets: number
  picks: ModelPick[]       // exact-line picks
  stretched: ModelPick[]   // full-ladder picks (paper until STRETCHED_VISIBLE)
  visible: ModelPick[]     // what Home/Feed show
}

/** Today's model picks (ET), each list sorted by edge desc. Throws on a query error. */
export async function loadTodayPicks(client: SupabaseClient, now = new Date()): Promise<TodayPicks> {
  const gameDate = todayEt(now)
  const [markets, props, alts, rungs] = await Promise.all([
    loadMarkets(client, gameDate),
    loadScored(client, 'props', gameDate),
    loadScored(client, 'prop_alts', gameDate),
    loadRungs(client, gameDate),
  ])
  const picks = matchPicks(markets, [...props, ...alts])
  const stretched = matchStretched(markets, rungs, now)
  return { gameDate, markets: markets.length, picks, stretched, visible: visiblePicks(picks, stretched) }
}

export interface ModelPickRow {
  id: number
  ticker: string
  side: 'yes' | 'no'
  player: string
  stat: string
  strike: number
  game_date: string
  tier: string
  kind: 'exact' | 'stretched'
  model_p: number | string
  price: number | string
  fee: number | string
  edge: number | string
  logged_at: string
  result: string | null
  won: boolean | null
  pnl: number | string | null
}

/** Every logged pick, newest game first (paged). */
export async function loadLoggedPicks(client: SupabaseClient): Promise<ModelPickRow[]> {
  const out: ModelPickRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from('kalshi_model_picks')
      .select('id, ticker, side, player, stat, strike, game_date, tier, kind, model_p, price, fee, edge, logged_at, result, won, pnl')
      .order('game_date', { ascending: false }).order('id', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`kalshi_model_picks: ${error.message}`)
    out.push(...((data ?? []) as ModelPickRow[]))
    if (!data || data.length < PAGE) break
  }
  return out
}
