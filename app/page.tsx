import { supabase } from '@/lib/supabase'
import type { Prop } from '@/types'
import ResultsHistory from '@/components/ResultsHistory'
import { ConfidenceExplainer } from '@/components/ConfidenceExplainer'
import { HomeContent } from '@/components/HomeContent'

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

export default async function HomePage() {
  const [{ games, allProps, stale }, results] = await Promise.all([getData(), getResults()])
  const gameDay = getGameDay(games)

  const propSummaries = allProps.map((p) => ({
    player_name: p.player_name,
    stat_type: p.stat_type,
    line: p.line,
    direction: p.direction as 'over' | 'under',
    confidence_score: p.confidence_score ?? null,
    confidence_label: p.confidence_label ?? null,
    game_id: p.game_id,
    team: p.team ?? null,
  }))

  return (
    <>
      <HomeContent games={games} allProps={propSummaries} stale={stale} gameDay={gameDay} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-10 flex flex-col gap-8">
        <ConfidenceExplainer />
        {results.length > 0 && <ResultsHistory results={results} />}
      </div>
    </>
  )
}
