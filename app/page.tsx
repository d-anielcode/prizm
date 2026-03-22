import { supabase } from '@/lib/supabase'
import type { Prop } from '@/types'
import Image from 'next/image'
import Link from 'next/link'
import ResultsHistory from '@/components/ResultsHistory'

export const revalidate = 0

const TEAM_ABBR: Record<string, string> = {
  // Full names
  'Atlanta Hawks': 'atl', 'Boston Celtics': 'bos', 'Brooklyn Nets': 'bkn',
  'Charlotte Hornets': 'cha', 'Chicago Bulls': 'chi', 'Cleveland Cavaliers': 'cle',
  'Dallas Mavericks': 'dal', 'Denver Nuggets': 'den', 'Detroit Pistons': 'det',
  'Golden State Warriors': 'gs', 'Houston Rockets': 'hou', 'Indiana Pacers': 'ind',
  'Los Angeles Clippers': 'lac', 'Los Angeles Lakers': 'lal', 'Memphis Grizzlies': 'mem',
  'Miami Heat': 'mia', 'Milwaukee Bucks': 'mil', 'Minnesota Timberwolves': 'min',
  'New Orleans Pelicans': 'no', 'New York Knicks': 'ny', 'Oklahoma City Thunder': 'okc',
  'Orlando Magic': 'orl', 'Philadelphia 76ers': 'phi', 'Phoenix Suns': 'phx',
  'Portland Trail Blazers': 'por', 'Sacramento Kings': 'sac', 'San Antonio Spurs': 'sa',
  'Toronto Raptors': 'tor', 'Utah Jazz': 'utah', 'Washington Wizards': 'wsh',
  // Short-form names returned by odds-api.io
  'LA Clippers': 'lac', 'LA Lakers': 'lal', 'Golden State': 'gs',
  'New Orleans': 'no', 'New York': 'ny', 'San Antonio': 'sa',
  'Oklahoma City': 'okc', 'Portland': 'por',
}

function teamLogoUrl(name: string | undefined | null): string | null {
  if (!name) return null
  const abbr = TEAM_ABBR[name]
  if (!abbr) return null
  return `https://a.espncdn.com/i/teamlogos/nba/500/${abbr}.png`
}

function teamAbbr(name: string | undefined | null): string {
  if (!name) return '???'
  return (TEAM_ABBR[name] ?? name.slice(0, 3)).toUpperCase()
}

interface GameInfo {
  game_id: string
  home_team: string | null
  away_team: string | null
  commence_time: string | null
  prop_count: number
}

function formatGameTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'America/New_York' })
  const day = d.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'America/New_York' })
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })
  return `${month} ${day} · ${time} ET`
}

function deduplicateProps(props: Prop[]): Prop[] {
  const best = new Map<string, Prop>()
  for (const prop of props) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.line}`
    const existing = best.get(key)
    if (!existing || (prop.confidence_score ?? 0) > (existing.confidence_score ?? 0)) {
      best.set(key, prop)
    }
  }
  return [...best.values()]
}

interface ResultRow {
  date: string
  confidence_label: string
  total: number
  hits: number
  hit_rate: number
}

async function getResults(): Promise<ResultRow[]> {
  const { data } = await supabase
    .from('prop_results')
    .select('*')
    .order('date', { ascending: false })
    .limit(56)
  return (data ?? []) as ResultRow[]
}

// Resolve team abbreviations from recent game logs (same logic as generate route)
const ABBR_NORM: Record<string, string> = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', NJ: 'NJN' }
function normaliseAbbr(abbr: string): string { return ABBR_NORM[abbr] ?? abbr }
function teamFromMatchup(matchup: string, isHome: boolean): string | null {
  if (matchup.includes(' @ ')) {
    const [away, home] = matchup.split(' @ ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  if (matchup.includes(' vs. ')) {
    const [home, away] = matchup.split(' vs. ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  return null
}

async function getData(): Promise<{ games: GameInfo[]; allProps: Prop[]; stale: boolean }> {
  const now = new Date().toISOString()

  // Helper to paginate a query
  async function fetchProps(futureOnly: boolean): Promise<Prop[]> {
    const rows: Prop[] = []
    let from = 0
    const PAGE = 1000
    while (true) {
      let q = supabase
        .from('props')
        .select('*')
        .order('confidence_score', { ascending: false, nullsFirst: false })
        .range(from, from + PAGE - 1)
      if (futureOnly) q = q.or(`commence_time.is.null,commence_time.gt.${now}`)
      const { data, error } = await q
      if (error) { console.error('[home] Supabase error:', error.message); break }
      if (!data || data.length === 0) break
      rows.push(...(data as Prop[]))
      if (data.length < PAGE) break
      from += PAGE
    }
    return rows
  }

  // First try: only upcoming games (normal case)
  let allRows = await fetchProps(true)
  let stale = false

  // Fallback: if table is empty or all games have started, show whatever is cached
  // This prevents a blank slate during the window between midnight and the morning cron
  if (allRows.length === 0) {
    allRows = await fetchProps(false)
    stale = true
    if (allRows.length > 0) {
      console.log('[home] No upcoming props found — showing stale cache as fallback')
    }
  }

  // Resolve actual team abbreviations for LOCK/PLAY props from recent game logs.
  // Props table stores team='TBD' for most players; game logs have the ground truth.
  const lockPlayPlayers = [...new Set(
    allRows
      .filter((p) => p.confidence_label === 'LOCK' || p.confidence_label === 'PLAY')
      .map((p) => p.player_name)
  )]
  if (lockPlayPlayers.length > 0) {
    const { data: logsRaw } = await supabase
      .from('player_game_logs')
      .select('player_name, matchup, is_home')
      .in('player_name', lockPlayPlayers)
      .order('game_date', { ascending: false })
      .limit(lockPlayPlayers.length * 3)

    const teamByPlayer = new Map<string, string>()
    for (const log of logsRaw ?? []) {
      if (!teamByPlayer.has(log.player_name) && log.matchup && log.is_home != null) {
        const abbr = teamFromMatchup(log.matchup as string, log.is_home as boolean)
        if (abbr) teamByPlayer.set(log.player_name as string, abbr)
      }
    }
    // Inject resolved team into props
    for (const prop of allRows) {
      const resolved = teamByPlayer.get(prop.player_name)
      if (resolved) prop.team = resolved
    }
  }

  // Auto-trigger enrichment if any props are unscored
  const unscoredCount = allRows.filter((p) => p.confidence_score == null).length
  if (unscoredCount > 0) {
    // Fire-and-forget — don't block page render on enrichment (30-60s)
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
    fetch(`${baseUrl}/api/enrich`, { method: 'GET' }).catch(() => {})
  }

  const deduped = deduplicateProps(allRows)

  // Group props by game_id
  const gameMap = new Map<string, GameInfo>()
  for (const prop of allRows) {
    if (!gameMap.has(prop.game_id)) {
      gameMap.set(prop.game_id, {
        game_id: prop.game_id,
        home_team: prop.home_team ?? null,
        away_team: prop.away_team ?? null,
        commence_time: prop.commence_time ?? null,
        prop_count: 0,
      })
    }
    // Prefer props that have team info
    const g = gameMap.get(prop.game_id)!
    if (!g.home_team && prop.home_team) g.home_team = prop.home_team
    if (!g.away_team && prop.away_team) g.away_team = prop.away_team
    if (!g.commence_time && prop.commence_time) g.commence_time = prop.commence_time
  }

  // Count deduped props per game
  for (const prop of deduped) {
    const g = gameMap.get(prop.game_id)
    if (g) g.prop_count++
  }

  // Filter to upcoming only when not in stale mode, sort by commence_time
  const games = [...gameMap.values()]
    .filter((g) => stale || g.commence_time == null || new Date(g.commence_time) > new Date())
    .sort((a, b) => {
      if (!a.commence_time) return 1
      if (!b.commence_time) return -1
      return new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime()
    })

  return { games, allProps: deduped, stale }
}

function getGameDay(games: GameInfo[]): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)

  const times = games
    .map((g) => (g.commence_time ? new Date(g.commence_time).getTime() : null))
    .filter((t): t is number => t !== null)

  if (times.length === 0) return "Today's"
  const earliest = new Date(Math.min(...times))
  earliest.setHours(0, 0, 0, 0)

  if (earliest.getTime() === today.getTime()) return "Today's"
  if (earliest.getTime() === tomorrow.getTime()) return "Tomorrow's"
  return earliest.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + "'s"
}

function TeamSide({
  name,
  align,
}: {
  name: string | null
  align: 'left' | 'right'
}) {
  const url = teamLogoUrl(name)
  const abbr = teamAbbr(name)
  const isRight = align === 'right'

  return (
    <div className={`flex items-center gap-3 flex-1 min-w-0 ${isRight ? 'justify-end flex-row-reverse' : ''}`}>
      {url ? (
        <Image src={url} alt={name ?? 'Team'} width={40} height={40} unoptimized className="object-contain shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white/40 text-xs font-bold shrink-0">
          {abbr}
        </div>
      )}
      <div className={`min-w-0 ${isRight ? 'text-right' : ''}`}>
        <div className="text-base font-black text-white tracking-tight leading-none">{abbr}</div>
        <div className="text-[11px] text-white/30 mt-0.5 truncate">{name ?? ''}</div>
      </div>
    </div>
  )
}

export default async function HomePage() {
  const [{ games, allProps, stale }, results] = await Promise.all([getData(), getResults()])
  const gameDay = getGameDay(games)

  const lock = allProps.filter((p) => p.confidence_label === 'LOCK').length
  const play = allProps.filter((p) => p.confidence_label === 'PLAY').length
  const lean = allProps.filter((p) => p.confidence_label === 'LEAN').length
  const fade = allProps.filter((p) => p.confidence_label === 'FADE').length

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 flex flex-col gap-10">

      {/* ── Page header ── */}
      <div className="flex flex-col gap-3">
        {stale && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            Showing last cached slate — today&apos;s lines not yet available. Updates automatically by 8 AM ET.
          </div>
        )}
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-4xl font-black text-white tracking-tight">{gameDay} Slate</h1>
          <span className="text-white/30 text-sm">{games.length} games</span>
        </div>

        {/* Confidence summary — 2×2 grid on mobile, single row on desktop */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:items-center sm:gap-6">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-violet-400">{lock}</span>
            <span className="text-xs text-white/30 uppercase tracking-wider">Lock</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-emerald-400">{play}</span>
            <span className="text-xs text-white/30 uppercase tracking-wider">Play</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-[#f0c060]">{lean}</span>
            <span className="text-xs text-white/30 uppercase tracking-wider">Lean</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-red-400">{fade}</span>
            <span className="text-xs text-white/30 uppercase tracking-wider">Fade</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">{allProps.length}</span>
            <span className="text-xs text-white/30 uppercase tracking-wider">Total</span>
          </div>
        </div>
      </div>

      {/* ── Game cards ── */}
      {games.length === 0 ? (
        <div className="py-20 text-center text-white/30">
          No upcoming games found. Run the seeder to populate props.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {games.map((game) => (
            <Link
              key={game.game_id}
              href={`/game/${encodeURIComponent(game.game_id)}`}
              className="group relative flex flex-col rounded-2xl border border-white/[0.07] bg-white/[0.03] hover:border-[#e8a820]/30 hover:bg-white/[0.05] transition-all duration-250 overflow-hidden"
            >
              {/* Gold accent top line */}
              <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/45 to-transparent" />

              {/* Matchup row */}
              <div className="flex items-center gap-3 px-5 py-5">
                <TeamSide name={game.away_team} align="left" />

                {/* Center: VS + time */}
                <div className="flex flex-col items-center gap-0.5 shrink-0 px-1">
                  <span className="text-[9px] font-bold text-white/20 uppercase tracking-widest">vs</span>
                  {game.commence_time && (
                    <span className="text-[11px] text-white/40 whitespace-nowrap">
                      {formatGameTime(game.commence_time)}
                    </span>
                  )}
                </div>

                <TeamSide name={game.home_team} align="right" />
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.05]">
                <span className="text-xs text-white/25">
                  {game.commence_time
                    ? new Date(game.commence_time).toLocaleDateString('en-US', {
                        month: 'short', day: 'numeric', timeZone: 'America/New_York',
                      })
                    : ''}
                </span>
                <span className="flex items-center gap-1 text-xs font-semibold text-white/35 group-hover:text-[#e8a820] transition-colors duration-200">
                  {game.prop_count} props
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* ── Model Performance / Results History ── */}
      {results.length > 0 && <ResultsHistory results={results} />}

    </div>
  )
}
