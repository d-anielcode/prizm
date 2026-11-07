import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { CURRENT_SEASON } from '@/lib/constants'
import { seasonDateRange, shiftSeason } from '@/lib/season'
import { playerNameVariants } from '@/lib/player-aliases'
import { normalizePlayerName } from '@/lib/lineups'
import {
  groupLadders, hitRate, MARKET_STATS, STAT_LABEL, type LadderLog, type MarketRow, type MarketStat,
} from '@/lib/kalshi/ladder'
import { MarketLadders, type RatesFor } from '@/components/MarketLadders'

export const dynamic = 'force-dynamic'

const PAGE = 1000
const STALE_MS = 90 * 60 * 1000

// Postgres numeric can arrive as a string from PostgREST; coerce defensively.
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))

async function loadMarkets(gameDate: string): Promise<MarketRow[]> {
  const out: MarketRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('kalshi_markets')
      .select('ticker, stat, player, strike, game_date, away, home, yes_bid, yes_ask, first_yes_ask, volume, status, updated_at')
      .eq('game_date', gameDate).in('stat', [...MARKET_STATS])
      .order('ticker').range(from, from + PAGE - 1)
    if (error) { console.error('[markets/props]', error.message); break }
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

type LogRow = LadderLog & { player_name: string }

async function loadLogs(players: string[]): Promise<Map<string, LadderLog[]>> {
  const names = [...new Set(players.flatMap(playerNameVariants))]
  const since = seasonDateRange(shiftSeason(CURRENT_SEASON, -1)).start
  const rows: LogRow[] = []
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('player_game_logs')
        .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
        .in('player_name', batch).gte('game_date', since)
        .order('game_date', { ascending: false }).range(from, from + PAGE - 1)
      if (error) { console.error('[markets/props] logs', error.message); break }
      rows.push(...((data ?? []) as LogRow[]))
      if (!data || data.length < PAGE) break
    }
  }
  const byKey = new Map<string, LadderLog[]>()
  for (const r of rows) {
    const k = normalizePlayerName(r.player_name)
    const list = byKey.get(k)
    if (list) list.push(r)
    else byKey.set(k, [r])
  }
  for (const logs of byKey.values()) logs.sort((a, b) => b.game_date.localeCompare(a.game_date))
  return byKey
}

export default async function MarketsProps({ searchParams }: { searchParams: Promise<{ stat?: string; game?: string }> }) {
  const { stat, game } = await searchParams
  const now = new Date()
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const all = await loadMarkets(today)
  const statFilter = (MARKET_STATS as readonly string[]).includes(stat ?? '') ? (stat as MarketStat) : null
  const rows = all.filter((r) => (!statFilter || r.stat === statFilter) && (!game || `${r.away}@${r.home}` === game))
  const games = groupLadders(rows)
  const gameKeys = [...new Set(all.map((r) => `${r.away}@${r.home}`))].sort()

  const logs = await loadLogs([...new Set(rows.map((r) => r.player))])
  const season = seasonDateRange(CURRENT_SEASON)
  const ratesFor: RatesFor = (player, s, strike) => {
    const l = logs.get(normalizePlayerName(player))
    if (!l?.length) return null
    return {
      l5: hitRate(l, s, strike, { last: 5 }),
      l10: hitRate(l, s, strike, { last: 10 }),
      season: hitRate(l, s, strike, { from: season.start, to: season.end }),
    }
  }

  const newest = all.reduce<string | null>((m, r) => (!m || r.updated_at > m ? r.updated_at : m), null)
  const stale = newest != null && now.getTime() - new Date(newest).getTime() > STALE_MS
  const asOf = newest && new Date(newest).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
  const href = (q: { stat?: string | null; game?: string | null }) => {
    const p = new URLSearchParams()
    const s = q.stat === undefined ? statFilter : q.stat
    const g = q.game === undefined ? game : q.game
    if (s) p.set('stat', s)
    if (g) p.set('game', g)
    const qs = p.toString()
    return `/markets/props${qs ? `?${qs}` : ''}`
  }
  const chip = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-semibold ${active ? 'bg-primary/20 text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
      <h1 className="mt-1 text-2xl font-bold text-[var(--text-primary)]">Kalshi player props</h1>
      <p className="mt-1 text-xs text-[var(--text-tertiary)]">
        {asOf ? `Prices as of ${asOf} ET` : 'No prices yet today'}
        {stale && <span className="ml-2 text-[#FFB800]">Prices may be stale</span>}
        {' · '}Break-even includes Kalshi&apos;s fee. Hit rates count games played at or above the rung.
      </p>

      <div className="mt-5 flex flex-wrap gap-1">
        <Link href={href({ stat: null })} className={chip(!statFilter)}>All stats</Link>
        {MARKET_STATS.map((s) => <Link key={s} href={href({ stat: s })} className={chip(statFilter === s)}>{STAT_LABEL[s]}</Link>)}
      </div>
      {gameKeys.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <Link href={href({ game: null })} className={chip(!game)}>All games</Link>
          {gameKeys.map((g) => <Link key={g} href={href({ game: g })} className={chip(game === g)}>{g.replace('@', ' @ ')}</Link>)}
        </div>
      )}

      <div className="mt-6">
        {games.length === 0
          ? <p className="text-sm text-[var(--text-secondary)]">No Kalshi player props listed for today yet.</p>
          : <MarketLadders games={games} ratesFor={ratesFor} />}
      </div>
    </div>
  )
}
