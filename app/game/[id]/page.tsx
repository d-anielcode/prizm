import { supabase } from '@/lib/supabase'
import { TEAM_ABBR } from '@/lib/team-abbr'
import GamePropsTable from '@/components/GamePropsTable'
import { loadLineupMap } from '@/lib/lineups'
import Link from 'next/link'
import type { AltLine, OpponentCtx, Prop, PropWithAlts, StatType } from '@/types'

// ── Matchup helpers (same as home page) ──────────────────────────────────────
const ABBR_NORM: Record<string, string> = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', NJ: 'NJN' }
function normaliseAbbr(a: string) { return ABBR_NORM[a] ?? a }
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

function getStatRank(row: Record<string, number | null>, stat: StatType): number | null {
  if (stat === 'points')        return row['pts_rank']  ?? null
  if (stat === 'rebounds')      return row['reb_rank']  ?? null
  if (stat === 'assists')       return row['ast_rank']  ?? null
  if (stat === 'steals')        return row['stl_rank']  ?? null
  if (stat === 'blocks')        return row['blk_rank']  ?? null
  if (stat === 'three_pointers') return row['fg3m_rank'] ?? null
  if (stat === 'pra') {
    const p = row['pts_rank'], r = row['reb_rank'], a = row['ast_rank']
    if (p != null && r != null && a != null) return Math.round((p + r + a) / 3)
  }
  return null
}

export const revalidate = 0

async function getGameProps(gameId: string): Promise<PropWithAlts[]> {
  const [{ data, error }, { data: alts }] = await Promise.all([
    supabase
      .from('props')
      .select('*')
      .eq('game_id', gameId)
      .order('confidence_score', { ascending: false, nullsFirst: false }),
    supabase
      .from('prop_alts')
      .select('*')
      .eq('game_id', gameId),
  ])

  if (error) {
    console.error('[game] Supabase error:', error.message)
    return []
  }

  const TIER_ORDER: Record<string, number> = { LOCK: 0, PLAY: 1, FADE: 2 }
  const props = ((data ?? []) as Prop[]).sort((a, b) => {
    const ta = TIER_ORDER[a.confidence_label ?? ''] ?? 4
    const tb = TIER_ORDER[b.confidence_label ?? ''] ?? 4
    if (ta !== tb) return ta - tb
    return (b.confidence_score ?? 0) - (a.confidence_score ?? 0)
  })
  const altRows = (alts ?? []) as (AltLine & { player_name: string; stat_type: string; game_id: string })[]

  return props.map((p) => ({
    ...p,
    altLines: altRows
      .filter((a) => a.player_name === p.player_name && a.stat_type === p.stat_type && a.direction === p.direction)
      .sort((a, b) => a.line - b.line),
  }))
}

async function buildOppCtx(props: PropWithAlts[]): Promise<Map<string, OpponentCtx>> {
  const result = new Map<string, OpponentCtx>()
  if (props.length === 0) return result

  const sample = props[0]
  const homeAbbr = sample.home_team ? (TEAM_ABBR[sample.home_team] ?? null) : null
  const awayAbbr = sample.away_team ? (TEAM_ABBR[sample.away_team] ?? null) : null
  const teamAbbrs = [homeAbbr, awayAbbr].filter(Boolean) as string[]
  if (teamAbbrs.length === 0) return result

  // Load defense stats + game logs + opponent leaks in parallel
  const uniqueNames = [...new Set(props.map((p) => p.player_name))]
  const [{ data: defRows }, { data: logsRaw }, { data: leakRows }] = await Promise.all([
    supabase.from('team_defense_stats').select('*').in('team_abbreviation', teamAbbrs),
    supabase
      .from('player_game_logs')
      .select('player_name, matchup, is_home')
      .in('player_name', uniqueNames)
      .order('game_date', { ascending: false })
      .limit(uniqueNames.length * 3),
    supabase
      .from('opponent_stat_leaks')
      .select('opponent_team, stat_type, over_hit_rate')
      .in('opponent_team', teamAbbrs),
  ])

  // Build defMap and leakMap
  const defMap = new Map<string, Record<string, number | null>>()
  for (const row of defRows ?? []) defMap.set(row.team_abbreviation as string, row as Record<string, number | null>)

  const leakMap = new Map<string, number>()
  for (const row of leakRows ?? []) {
    leakMap.set(`${row.opponent_team}|${row.stat_type}`, Number(row.over_hit_rate))
  }

  // Resolve player → team abbr from most recent game log
  const teamByPlayer = new Map<string, string>()
  for (const log of logsRaw ?? []) {
    if (!teamByPlayer.has(log.player_name as string) && log.matchup && log.is_home != null) {
      const abbr = teamFromMatchup(log.matchup as string, log.is_home as boolean)
      if (abbr) teamByPlayer.set(log.player_name as string, abbr)
    }
  }

  for (const prop of props) {
    if (!prop.id) continue
    const playerTeam = teamByPlayer.get(prop.player_name)
    if (!playerTeam) continue
    const oppAbbr = playerTeam === homeAbbr ? awayAbbr : playerTeam === awayAbbr ? homeAbbr : null
    if (!oppAbbr) continue
    const defRow = defMap.get(oppAbbr) ?? null
    const rank = defRow ? getStatRank(defRow, prop.stat_type) : null
    const overHitRate = leakMap.get(`${oppAbbr}|${prop.stat_type}`) ?? null
    result.set(prop.id, { oppAbbr, rank, overHitRate })
  }

  return result
}

// ── Prop result grading for completed games ───────────────────────────────────
export interface PropResult {
  hit:    boolean | null   // null = DNP / no log
  actual: number  | null
}

function getActualForStat(log: Record<string, unknown>, stat: StatType): number | null {
  if (stat === 'points')         return Number(log.points   ?? 0)
  if (stat === 'rebounds')       return Number(log.rebounds ?? 0)
  if (stat === 'assists')        return Number(log.assists  ?? 0)
  if (stat === 'steals')         return Number(log.steals   ?? 0)
  if (stat === 'blocks')         return Number(log.blocks   ?? 0)
  if (stat === 'three_pointers') return Number(log.fg3m     ?? 0)
  if (stat === 'pra')            return Number(log.pra      ?? 0)
  return null
}

async function gradeGameProps(
  props: PropWithAlts[],
  commenceTime: string | null,
): Promise<Map<string, PropResult>> {
  const results = new Map<string, PropResult>()
  if (!commenceTime || new Date(commenceTime) > new Date()) return results  // game not yet played

  // Game date in ET
  const gameDate = new Date(commenceTime).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const uniqueNames = [...new Set(props.map((p) => p.player_name))]

  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
    .in('player_name', uniqueNames)
    .eq('game_date', gameDate)

  const logIndex = new Map<string, Record<string, unknown>>()
  for (const log of logsRaw ?? []) logIndex.set(log.player_name as string, log as Record<string, unknown>)

  for (const prop of props) {
    if (!prop.id) continue
    const log = logIndex.get(prop.player_name)
    if (!log || Number(log.minutes ?? 0) < 5) {
      results.set(prop.id, { hit: null, actual: null })
      continue
    }
    const actual = getActualForStat(log, prop.stat_type)
    const hit = actual === null ? null
      : prop.direction === 'over' ? actual > prop.line : actual < prop.line
    results.set(prop.id, { hit, actual })
  }

  return results
}

// ── ESPN injury fetch ─────────────────────────────────────────────────────────
type InjuryStatus = 'out' | 'doubtful' | 'questionable'
interface InjuryAlert { playerName: string; status: InjuryStatus }

async function fetchInjuriesForGame(propPlayers: string[]): Promise<InjuryAlert[]> {
  const playerSet = new Set(propPlayers.map((n) => n.toLowerCase()))
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      { next: { revalidate: 1800 } }
    )
    if (!res.ok) return []
    const data = await res.json() as {
      injuries?: Array<{
        athlete?: { displayName?: string }
        type?:    { description?: string }
        status?:  string
      }>
    }
    const alerts: InjuryAlert[] = []
    for (const item of data.injuries ?? []) {
      const name = item.athlete?.displayName?.trim()
      if (!name || !playerSet.has(name.toLowerCase())) continue
      const raw = (item.type?.description ?? item.status ?? '').toLowerCase()
      let status: InjuryStatus | null = null
      if (raw.includes('out'))          status = 'out'
      else if (raw.includes('doubtful')) status = 'doubtful'
      else if (raw.includes('question')) status = 'questionable'
      if (status) alerts.push({ playerName: name, status })
    }
    return alerts
  } catch {
    return []
  }
}

function formatGameTime(iso: string | undefined | null): string {
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

export default async function GamePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const gameId = decodeURIComponent(id)
  const props = await getGameProps(gameId)
  const uniquePropPlayers = [...new Set(props.map((p) => p.player_name))]
  // Pull today's lineup map alongside the other async loads. Same date logic
  // as the lineup cron (ET game date). Falls back to empty Map on error.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [oppCtx, injuries, propResults, lineupMap] = await Promise.all([
    buildOppCtx(props),
    fetchInjuriesForGame(uniquePropPlayers),
    gradeGameProps(props, props[0]?.commence_time ?? null),
    loadLineupMap(supabase, todayET),
  ])

  // Extract team names and game time from props (any prop will do)
  const sample = props[0]
  const homeTeam = sample?.home_team ?? null
  const awayTeam = sample?.away_team ?? null
  const commenceTime = sample?.commence_time ?? null

  const matchupLabel =
    homeTeam && awayTeam
      ? `${awayTeam} @ ${homeTeam}`
      : `Game ${gameId}`

  const lock = props.filter((p) => p.confidence_label === 'LOCK').length
  const play = props.filter((p) => p.confidence_label === 'PLAY').length
  const fade = props.filter((p) => p.confidence_label === 'FADE').length

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      {/* Back link */}
      <Link
        href="/"
        className="text-sm text-white/40 hover:text-white/70 transition-colors w-fit"
      >
        ← Back to Games
      </Link>

      {/* Matchup header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-white">{matchupLabel}</h1>
        {commenceTime && (
          <p className="text-white/40 text-sm">{formatGameTime(commenceTime)}</p>
        )}
        <p className="text-white/40 text-sm mt-1">
          {props.length} props scored
        </p>
      </div>

      {/* Confidence summary */}
      {props.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <div className="px-4 py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-sm">
            <span className="text-violet-400 font-semibold">{lock}</span>
            <span className="text-white/40 ml-1.5">Lock</span>
          </div>
          <div className="px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
            <span className="text-emerald-400 font-semibold">{play}</span>
            <span className="text-white/40 ml-1.5">Play</span>
          </div>
          <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
            <span className="text-red-400 font-semibold">{fade}</span>
            <span className="text-white/40 ml-1.5">Fade</span>
          </div>
        </div>
      )}

      {/* Injury banner */}
      {injuries.length > 0 && (
        <div className="flex flex-col gap-2">
          {injuries
            .sort((a, b) => {
              const order = { out: 0, doubtful: 1, questionable: 2 }
              return order[a.status] - order[b.status]
            })
            .map((inj) => {
              const isOut       = inj.status === 'out'
              const isDoubtful  = inj.status === 'doubtful'
              return (
                <div
                  key={inj.playerName}
                  className={[
                    'flex items-center gap-3 px-4 py-3 rounded-xl border text-sm',
                    isOut      ? 'bg-red-500/[0.08] border-red-500/25'
                    : isDoubtful ? 'bg-orange-500/[0.08] border-orange-500/25'
                    :              'bg-yellow-500/[0.06] border-yellow-500/20',
                  ].join(' ')}
                >
                  <svg className={`w-4 h-4 shrink-0 ${isOut ? 'text-red-400' : isDoubtful ? 'text-orange-400' : 'text-yellow-400'}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  </svg>
                  <span className="font-semibold text-white">{inj.playerName}</span>
                  <span className={[
                    'text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full',
                    isOut      ? 'text-red-400 bg-red-500/15'
                    : isDoubtful ? 'text-orange-400 bg-orange-500/15'
                    :              'text-yellow-400 bg-yellow-500/10',
                  ].join(' ')}>
                    {inj.status}
                  </span>
                  <span className="text-white/35 text-xs">
                    {isOut ? 'Props will not result — player not playing'
                    : isDoubtful ? 'Unlikely to play — high miss risk'
                    : 'Game-time decision — monitor before betting'}
                  </span>
                </div>
              )
            })}
        </div>
      )}

      {/* Props list */}
      {props.length === 0 ? (
        <div className="py-20 text-center text-white/30">
          No props found for this game.
        </div>
      ) : (
        <GamePropsTable props={props} oppCtx={oppCtx} propResults={propResults} lineupMap={lineupMap} />
      )}
    </div>
  )
}
