import { supabase } from '@/lib/supabase'
import { ConfidenceBadge } from '@/components/ConfidenceBadge'
import { StatChart } from '@/components/StatChart'
import Link from 'next/link'
import type { Prop, StatType } from '@/types'
import { getEspnVariants } from '@/lib/player-aliases'
import { TEAM_ABBR } from '@/lib/team-abbr'
import { CURRENT_SEASON } from '@/lib/constants'

export const revalidate = 0

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

interface GameLog {
  date:     string
  matchup:  string
  isHome:   boolean
  points:   number
  rebounds: number
  assists:  number
  steals:   number
  blocks:   number
  fg3m:     number
  pra:      number
  minutes:  number
  win:      boolean
}

interface SeasonStats {
  games_played: number
  avg_points:   number | null
  avg_rebounds: number | null
  avg_assists:  number | null
  avg_steals:   number | null
  avg_blocks:   number | null
  avg_fg3m:     number | null
  avg_pra:      number | null
  avg_minutes:  number | null
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
function getStatValue(g: GameLog, statType: StatType): number {
  switch (statType) {
    case 'points':         return g.points
    case 'rebounds':       return g.rebounds
    case 'assists':        return g.assists
    case 'steals':         return g.steals
    case 'blocks':         return g.blocks
    case 'three_pointers': return g.fg3m
    case 'pra':            return g.pra
    default:               return 0
  }
}

function extractOpponent(matchup: string): string | null {
  return matchup.split(/\s+vs\.\s+|\s+@\s+/)[1]?.trim().toUpperCase() ?? null
}

function computeAvgs(logs: GameLog[]) {
  const n = logs.length
  if (n === 0) return null
  const sum = (fn: (g: GameLog) => number) =>
    +(logs.reduce((s, g) => s + fn(g), 0) / n).toFixed(1)
  return {
    n,
    pts:  sum((g) => g.points),
    reb:  sum((g) => g.rebounds),
    ast:  sum((g) => g.assists),
    stl:  sum((g) => g.steals),
    blk:  sum((g) => g.blocks),
    fg3m: sum((g) => g.fg3m),
    pra:  sum((g) => g.pra),
  }
}

function formatDate(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [year, month, day] = dateStr.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    })
  }
  return dateStr.replace(/,\s*\d{4}/, '').trim()
}

function formatGameTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET'
}

function hitRate(logs: GameLog[], statType: StatType, line: number, direction: 'over' | 'under') {
  const recent = logs.filter((g) => g.minutes >= 5).slice(0, 10)
  const hits = recent.filter((g) => {
    const v = getStatValue(g, statType)
    return direction === 'over' ? v > line : v < line
  }).length
  return { hits, total: recent.length }
}

function deduplicateProps(props: Prop[]): Prop[] {
  const best = new Map<string, Prop>()
  for (const prop of props) {
    const existing = best.get(prop.stat_type)
    if (!existing || (prop.confidence_score ?? 0) > (existing.confidence_score ?? 0)) {
      best.set(prop.stat_type, prop)
    }
  }
  return [...best.values()].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
}

// ── Line movement indicators ──────────────────────────────────────────────────
function LineMovement({ opening, current }: { opening: number | null | undefined; current: number }) {
  if (opening == null || opening === current) return null
  const delta = current - opening
  const moved = Math.abs(delta)
  if (moved < 0.5) return null
  const up = delta > 0
  return (
    <span
      className={`text-[10px] font-bold ml-1.5 ${up ? 'text-orange-400' : 'text-emerald-400'}`}
      title={`Line moved from ${opening} → ${current}`}
    >
      {up ? '↑' : '↓'}{moved % 1 === 0 ? moved.toFixed(0) : moved.toFixed(1)}
    </span>
  )
}

function SharpMoneyBadge({ opening, current, direction }: { opening: number | null | undefined; current: number; direction: 'over' | 'under' }) {
  if (opening == null) return null
  const delta = current - opening
  if (Math.abs(delta) < 0.5) return null
  // Line moved with direction = sharp money confirming (e.g. OVER and line went up)
  const confirming = direction === 'over' ? delta > 0 : delta < 0
  return (
    <span
      className={`text-[9px] font-black px-1.5 py-0.5 rounded ${confirming ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/15 text-red-400'}`}
      title={confirming ? 'Sharp money confirming this pick (line moved with direction)' : 'Sharp money against this pick (line moved opposite direction)'}
    >
      {confirming ? 'STEAM' : 'COUNTER'}
    </span>
  )
}

// ── Hit/Miss game-by-game bubbles ─────────────────────────────────────────────
function HitMissRow({
  logs,
  statType,
  line,
  direction,
}: {
  logs:      GameLog[]
  statType:  StatType
  line:      number
  direction: 'over' | 'under'
}) {
  const relevant = logs.filter((g) => g.minutes >= 5).slice(0, 10)
  if (relevant.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">
        Last {relevant.length} games vs {line} line
      </p>
      <div className="flex items-end gap-2 flex-wrap">
        {relevant.map((g, i) => {
          const val = getStatValue(g, statType)
          const hit = direction === 'over' ? val > line : val < line
          const opp = extractOpponent(g.matchup) ?? '—'
          return (
            <div key={i} className="flex flex-col items-center gap-1" title={`${formatDate(g.date)} vs ${opp}: ${val}`}>
              <span className="text-[9px] text-white/20 font-medium">{opp}</span>
              <div className={[
                'w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold border-2',
                hit
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                  : 'bg-red-500/15 border-red-500/40 text-red-400',
              ].join(' ')}>
                {val}
              </div>
              <span className={`text-[9px] font-bold ${hit ? 'text-emerald-500' : 'text-red-500/70'}`}>
                {hit ? '✓' : '✗'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Reusable stat grid ────────────────────────────────────────────────────────
function StatGrid({
  label,
  subLabel,
  stats,
  highlight,
}: {
  label: string
  subLabel?: string
  stats: Array<[string, number | null]>
  highlight?: boolean
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <p className="text-xs font-semibold text-white/35 uppercase tracking-wider">{label}</p>
        {subLabel && <p className="text-xs text-white/20">{subLabel}</p>}
      </div>
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {stats.map(([lbl, value]) => (
          <div
            key={lbl}
            className={[
              'rounded-xl border p-3 text-center',
              highlight
                ? 'bg-[#f0c060]/[0.06] border-[#f0c060]/[0.15]'
                : 'bg-white/[0.04] border-white/[0.07]',
            ].join(' ')}
          >
            <div className="text-xl font-bold text-white">
              {value !== null && value !== undefined ? value : '—'}
            </div>
            <div className="text-xs text-white/35 mt-0.5">{lbl}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Home/Away comparison ──────────────────────────────────────────────────────
type SplitAvgs = ReturnType<typeof computeAvgs>

function HomeAwaySplits({
  home,
  away,
}: {
  home: SplitAvgs
  away: SplitAvgs
}) {
  if (!home || !away) return null
  const stats: Array<[string, keyof NonNullable<SplitAvgs>]> = [
    ['PTS', 'pts'], ['REB', 'reb'], ['AST', 'ast'],
    ['STL', 'stl'], ['BLK', 'blk'], ['3PM', 'fg3m'], ['PRA', 'pra'],
  ]
  return (
    <div>
      <p className="text-xs font-semibold text-white/35 uppercase tracking-wider mb-3">
        Home / Away Splits
      </p>
      <div className="rounded-xl border border-white/[0.07] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/[0.04] text-white/35 text-xs uppercase tracking-wider">
              <th className="px-4 py-2.5 text-left font-semibold">Split</th>
              {stats.map(([lbl]) => (
                <th key={lbl} className="px-2 py-2.5 text-right font-semibold">{lbl}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {([
              { label: `Home (${home.n}G)`, avgs: home, isHome: true },
              { label: `Away (${away.n}G)`, avgs: away, isHome: false },
            ] as const).map(({ label, avgs }) => (
              <tr key={label} className="hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-2.5 text-white/55 font-medium whitespace-nowrap">
                  {label}
                </td>
                {stats.map(([lbl, key]) => {
                  const val = avgs[key] as number
                  const other = (label.startsWith('Home') ? away : home)[key] as number
                  const diff = val - other
                  return (
                    <td
                      key={lbl}
                      className={[
                        'px-2 py-2.5 text-right font-mono font-semibold',
                        Math.abs(diff) >= 1.5
                          ? diff > 0 ? 'text-emerald-400' : 'text-red-400'
                          : 'text-white/75',
                      ].join(' ')}
                    >
                      {val}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default async function PlayerPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const playerName = decodeURIComponent(name)
  const now = new Date().toISOString()

  // ── 1. Props ──────────────────────────────────────────────────────────────────
  const { data: rawProps } = await supabase
    .from('props')
    .select('*')
    .ilike('player_name', playerName)
    .or(`commence_time.is.null,commence_time.gt.${now}`)
    .order('confidence_score', { ascending: false, nullsFirst: false })

  const playerProps = deduplicateProps((rawProps ?? []) as Prop[])
  const firstProp   = (rawProps ?? [])[0] as Prop | undefined
  const commence    = firstProp?.commence_time
  const homeTeam    = firstProp?.home_team ?? ''
  const awayTeam    = firstProp?.away_team ?? ''

  // ── 2. ALL game logs (no limit — needed for full-season splits) ───────────────
  const nameVariants = getEspnVariants(playerName)
  const { data: logRows } = await supabase
    .from('player_game_logs')
    .select('*')
    .in('player_name', nameVariants)
    .order('game_date', { ascending: false })

  // ── 3. Grade history (past Prizm picks for this player) ──────────────────────
  const { data: gradeRows } = await supabase
    .from('prop_grades')
    .select('game_date, stat_type, line, direction, confidence_label, confidence_score, actual_value, hit')
    .in('player_name', nameVariants)
    .not('hit', 'is', null)
    .order('game_date', { ascending: false })
    .limit(20)

  // ── 4. Season stats ───────────────────────────────────────────────────────────
  const { data: seasonRows } = await supabase
    .from('player_season_stats')
    .select('*')
    .in('player_name', nameVariants)
    .eq('season', CURRENT_SEASON)
    .order('games_played', { ascending: false })
    .limit(1)

  const seasonStats: SeasonStats | null = seasonRows?.[0]
    ? (seasonRows[0] as unknown as SeasonStats)
    : null

  // ── 5. Derive team / opponent context ─────────────────────────────────────────
  const latestMatchup   = (logRows?.[0]?.matchup as string) ?? ''
  const matchParts      = latestMatchup.split(/\s+vs\.\s+|\s+@\s+/)
  const playerTeamAbbr  = matchParts[0]?.trim().toUpperCase() ?? ''

  const homeAbbr = homeTeam ? (TEAM_ABBR[homeTeam] ?? null) : null
  const awayAbbr = awayTeam ? (TEAM_ABBR[awayTeam] ?? null) : null

  // Figure out which abbreviation is tonight's opponent
  let tonightOpponentAbbr: string | null = null
  let isHomeTonight: boolean | null = null
  if (playerTeamAbbr && homeAbbr && awayAbbr) {
    if (playerTeamAbbr === homeAbbr) {
      isHomeTonight = true
      tonightOpponentAbbr = awayAbbr
    } else if (playerTeamAbbr === awayAbbr) {
      isHomeTonight = false
      tonightOpponentAbbr = homeAbbr
    }
  }

  const opponentDisplay = tonightOpponentAbbr ?? (awayTeam || homeTeam)
  const team     = playerTeamAbbr || (firstProp?.team !== 'TBD' ? (firstProp?.team ?? '') : '')
  const opponent = opponentDisplay && opponentDisplay !== 'TBD' ? opponentDisplay : ''

  // ── 6. Map all game logs ──────────────────────────────────────────────────────
  const gameLogs: GameLog[] = (logRows ?? []).map((g) => ({
    date:     String(g.game_date ?? ''),
    matchup:  String(g.matchup ?? ''),
    isHome:   Boolean(g.is_home),
    points:   Number(g.points   ?? 0),
    rebounds: Number(g.rebounds ?? 0),
    assists:  Number(g.assists  ?? 0),
    steals:   Number(g.steals   ?? 0),
    blocks:   Number(g.blocks   ?? 0),
    fg3m:     Number(g.fg3m     ?? 0),
    pra:      Number(g.pra      ?? 0),
    minutes:  Number(g.minutes  ?? 0),
    win:      Boolean(g.win),
  }))

  // ── 7. Compute splits ─────────────────────────────────────────────────────────
  const homeGames = gameLogs.filter((g) => g.isHome)
  const awayGames = gameLogs.filter((g) => !g.isHome)
  const homeAvgs  = computeAvgs(homeGames)
  const awayAvgs  = computeAvgs(awayGames)
  const showHomeAway = (homeAvgs?.n ?? 0) >= 5 && (awayAvgs?.n ?? 0) >= 5

  // vs. tonight's opponent (needs ≥ 2 games for any signal)
  const vsOpponentGames = tonightOpponentAbbr
    ? gameLogs.filter((g) => extractOpponent(g.matchup) === tonightOpponentAbbr)
    : []
  const vsOpponentAvgs = computeAvgs(vsOpponentGames)

  // L20 averages (just from the most recent 20 games)
  const l20logs = gameLogs.slice(0, 20)
  const l20Avgs = computeAvgs(l20logs)

  // Logs shown in the table (last 20)
  const tableGames = gameLogs.slice(0, 20)

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">

      {/* Back link */}
      <Link href="/props" className="text-sm text-white/40 hover:text-white/70 transition-colors w-fit">
        ← Back to props
      </Link>

      {/* ── Player header ── */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold text-white">{playerName}</h1>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          {team && <span className="text-white/50 font-medium">{team}</span>}
          {opponent && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-white/50">
                vs {opponent}
                {isHomeTonight !== null && (
                  <span className="ml-1 text-white/30 text-xs">
                    ({isHomeTonight ? 'Home' : 'Away'})
                  </span>
                )}
              </span>
            </>
          )}
          {commence && (
            <>
              <span className="text-white/20">·</span>
              <span className="text-[#f0c060]">{formatGameTime(commence)}</span>
            </>
          )}
        </div>
      </div>

      {/* ── Season averages ── */}
      {seasonStats ? (
        <StatGrid
          label={`${CURRENT_SEASON} Season`}
          subLabel={`${seasonStats.games_played} games played`}
          stats={[
            ['PTS',  seasonStats.avg_points],
            ['REB',  seasonStats.avg_rebounds],
            ['AST',  seasonStats.avg_assists],
            ['STL',  seasonStats.avg_steals],
            ['BLK',  seasonStats.avg_blocks],
            ['3PM',  seasonStats.avg_fg3m],
            ['PRA',  seasonStats.avg_pra],
          ]}
        />
      ) : (
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-center text-white/30 text-sm">
          Season averages unavailable —{' '}
          <code className="text-white/40 text-xs">
            /api/seasonstats?player={encodeURIComponent(playerName)}
          </code>
        </div>
      )}

      {/* ── Home / Away splits ── */}
      {showHomeAway && homeAvgs && awayAvgs && (
        <HomeAwaySplits home={homeAvgs} away={awayAvgs} />
      )}

      {/* ── vs. Tonight's Opponent ── */}
      {vsOpponentAvgs && vsOpponentAvgs.n >= 2 && tonightOpponentAbbr && (
        <div>
          <p className="text-xs font-semibold text-white/35 uppercase tracking-wider mb-3">
            vs. {tonightOpponentAbbr} this season
            <span className="normal-case font-normal ml-1 text-white/20">
              ({vsOpponentAvgs.n} game{vsOpponentAvgs.n !== 1 ? 's' : ''})
            </span>
          </p>
          <StatGrid
            label=""
            stats={[
              ['PTS',  vsOpponentAvgs.pts],
              ['REB',  vsOpponentAvgs.reb],
              ['AST',  vsOpponentAvgs.ast],
              ['STL',  vsOpponentAvgs.stl],
              ['BLK',  vsOpponentAvgs.blk],
              ['3PM',  vsOpponentAvgs.fg3m],
              ['PRA',  vsOpponentAvgs.pra],
            ]}
            highlight
          />
        </div>
      )}

      {/* ── Last 20 averages ── */}
      {l20Avgs && l20Avgs.n >= 3 && (
        <StatGrid
          label={`Last ${l20Avgs.n} Games`}
          subLabel="recent form"
          stats={[
            ['PTS',  l20Avgs.pts],
            ['REB',  l20Avgs.reb],
            ['AST',  l20Avgs.ast],
            ['STL',  l20Avgs.stl],
            ['BLK',  l20Avgs.blk],
            ['3PM',  l20Avgs.fg3m],
            ['PRA',  l20Avgs.pra],
          ]}
        />
      )}

      {/* ── Today's props ── */}
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-white">Today&apos;s Props</h2>

        {playerProps.length > 0 ? playerProps.map((prop, i) => {
          const chartData = gameLogs.slice(0, 20).map((g) => ({
            date:  formatDate(g.date),
            value: getStatValue(g, prop.stat_type),
          }))
          const { hits, total } = hitRate(gameLogs, prop.stat_type, prop.line, prop.direction)
          const hitPct = total > 0 ? Math.round((hits / total) * 100) : null

          return (
            <div
              key={prop.id ?? i}
              className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-5 flex flex-col gap-4 card-glow"
            >
              {/* Prop title row */}
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-lg font-bold text-white">
                    {STAT_LABELS[prop.stat_type]}
                  </span>
                  <span className={[
                    'text-sm font-semibold px-3 py-0.5 rounded-full inline-flex items-center',
                    prop.direction === 'over'
                      ? 'bg-blue-500/15 text-blue-400'
                      : 'bg-orange-500/15 text-orange-400',
                  ].join(' ')}>
                    {prop.direction.toUpperCase()} {prop.line}
                    <LineMovement opening={prop.opening_line} current={prop.line} />
                  </span>
                  <SharpMoneyBadge opening={prop.opening_line} current={prop.line} direction={prop.direction} />
                  {hitPct !== null && total >= 5 && (
                    <span className={[
                      'text-xs font-semibold px-2.5 py-0.5 rounded-full',
                      hitPct >= 70 ? 'bg-green-500/15 text-green-400'
                      : hitPct >= 50 ? 'bg-yellow-500/15 text-yellow-400'
                      : 'bg-red-500/15 text-red-400',
                    ].join(' ')}>
                      {hits}/{total} L{total}
                    </span>
                  )}
                </div>
                {prop.confidence_label && prop.confidence_score != null && (
                  <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                )}
              </div>

              {prop.confidence_reason && (
                <p className="text-sm text-white/45 leading-relaxed">{prop.confidence_reason}</p>
              )}

              <HitMissRow
                logs={gameLogs}
                statType={prop.stat_type}
                line={prop.line}
                direction={prop.direction}
              />

              {chartData.length > 0 ? (
                <StatChart
                  games={chartData}
                  line={prop.line}
                  statLabel={STAT_LABELS[prop.stat_type]}
                  direction={prop.direction}
                />
              ) : (
                <div className="h-24 flex items-center justify-center text-white/25 text-sm rounded-xl bg-white/[0.02] border border-white/[0.05]">
                  No recent game data
                </div>
              )}
            </div>
          )
        }) : (
          <div className="py-12 text-center rounded-2xl border border-white/[0.07] bg-white/[0.02]">
            <p className="text-white/40 text-sm">No upcoming props found for {playerName}.</p>
            <p className="text-white/25 text-xs mt-1">
              Props are populated when today&apos;s games are seeded.
            </p>
          </div>
        )}
      </div>

      {/* ── Pick History (past Prizm graded picks) ── */}
      {gradeRows && gradeRows.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-white">Pick History</h2>
          <p className="text-xs text-white/30 -mt-1">Prizm&apos;s past confidence picks for {playerName} — graded after games</p>
          <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] bg-white/[0.04] text-white/40 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Pick</th>
                  <th className="px-4 py-3 text-left">Label</th>
                  <th className="px-4 py-3 text-right">Actual</th>
                  <th className="px-4 py-3 text-center">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {gradeRows.map((g, i) => {
                  const labelColors: Record<string, string> = {
                    LOCK: 'text-violet-400',
                    PLAY: 'text-emerald-400',
                    LEAN: 'text-[#f0c060]',
                    FADE: 'text-red-400',
                  }
                  const hit = g.hit as boolean | null
                  return (
                    <tr key={i} className="hover:bg-white/[0.03] transition-colors">
                      <td className="px-4 py-2.5 text-white/55 whitespace-nowrap font-medium">
                        {formatDate(String(g.game_date ?? ''))}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full inline-block ${(g.direction as string) === 'over' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400'}`}>
                          {(g.direction as string) === 'over' ? 'O' : 'U'}{g.line} {STAT_LABELS[g.stat_type as StatType] ?? String(g.stat_type)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-xs font-black ${labelColors[String(g.confidence_label ?? '')] ?? 'text-white/40'}`}>
                          {g.confidence_label}
                        </span>
                        {g.confidence_score != null && (
                          <span className="text-[10px] text-white/20 ml-1">({g.confidence_score})</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-white/60">
                        {g.actual_value != null ? g.actual_value : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`text-xs font-black ${hit === true ? 'text-emerald-400' : hit === false ? 'text-red-400' : 'text-white/25'}`}>
                          {hit === true ? '✓ HIT' : hit === false ? '✗ MISS' : 'VOID'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Recent game log table ── */}
      {tableGames.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-white">Recent Game Log</h2>
          <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.08] bg-white/[0.04] text-white/40 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Matchup</th>
                  <th className="px-4 py-3 text-right">PTS</th>
                  <th className="px-4 py-3 text-right">REB</th>
                  <th className="px-4 py-3 text-right">AST</th>
                  <th className="px-4 py-3 text-right">STL</th>
                  <th className="px-4 py-3 text-right">BLK</th>
                  <th className="px-4 py-3 text-right">3PM</th>
                  <th className="px-4 py-3 text-right">MIN</th>
                  <th className="px-4 py-3 text-right">W/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {tableGames.map((g, i) => (
                  <tr key={i} className="hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-2.5 text-white/55 whitespace-nowrap font-medium">
                      {formatDate(g.date)}
                    </td>
                    <td className="px-4 py-2.5 text-white/40 text-xs whitespace-nowrap">
                      {g.matchup}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-white">
                      {g.points}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-white/75">{g.rebounds}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white/75">{g.assists}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white/55">{g.steals}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white/55">{g.blocks}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white/55">{g.fg3m}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-white/35">{g.minutes}</td>
                    <td className={[
                      'px-4 py-2.5 text-right text-xs font-bold',
                      g.win ? 'text-green-400' : 'text-red-400',
                    ].join(' ')}>
                      {g.win ? 'W' : 'L'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
