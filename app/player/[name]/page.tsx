import { supabase } from '@/lib/supabase'
import { ConfidenceBadge } from '@/components/ConfidenceBadge'
import { StatChart } from '@/components/StatChart'
import Link from 'next/link'
import type { Prop, StatType } from '@/types'

export const revalidate = 0

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

interface GameLog {
  date: string
  matchup: string
  points: number
  rebounds: number
  assists: number
  steals: number
  blocks: number
  fg3m: number
  pra: number
  minutes: number
  win: boolean
}

function getStatValue(game: GameLog, statType: StatType): number {
  switch (statType) {
    case 'points':         return game.points
    case 'rebounds':       return game.rebounds
    case 'assists':        return game.assists
    case 'steals':         return game.steals
    case 'blocks':         return game.blocks
    case 'three_pointers': return game.fg3m
    case 'pra':            return game.pra
    default:               return 0
  }
}

function formatDate(dateStr: string): string {
  // ISO format "2026-03-18" → "Mar 18"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [year, month, day] = dateStr.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  }
  // Legacy "MAR 18, 2026" → strip year
  return dateStr.replace(/,\s*\d{4}/, '').trim()
}

function formatGameTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  }) + ' ET'
}

function hitRate(logs: GameLog[], statType: StatType, line: number, direction: 'over' | 'under') {
  const recent = logs.slice(0, 10)
  let hits = 0
  for (const g of recent) {
    const val = getStatValue(g, statType)
    if (direction === 'over' ? val > line : val < line) hits++
  }
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

export default async function PlayerPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const playerName = decodeURIComponent(name)
  const now = new Date().toISOString()

  // Fetch upcoming scored props for this player
  const { data: rawProps } = await supabase
    .from('props')
    .select('*')
    .ilike('player_name', playerName)
    .not('confidence_score', 'is', null)
    .or(`commence_time.is.null,commence_time.gt.${now}`)
    .order('confidence_score', { ascending: false, nullsFirst: false })

  const playerProps = deduplicateProps((rawProps ?? []) as Prop[])

  // Grab context from first prop
  const firstProp = (rawProps ?? [])[0] as Prop | undefined
  const team       = firstProp?.team ?? ''
  const opponent   = firstProp?.opponent ?? ''
  const commence   = firstProp?.commence_time

  // Fetch recent game logs
  const { data: logRows } = await supabase
    .from('player_game_logs')
    .select('*')
    .ilike('player_name', playerName)
    .order('game_date', { ascending: false })
    .limit(20)

  const gameLogs: GameLog[] = (logRows ?? []).map((g) => ({
    date:     String(g.game_date ?? ''),
    matchup:  String(g.matchup ?? ''),
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

  // Averages over available game logs
  const n = gameLogs.length
  const avg = n >= 5 ? {
    pts:  +(gameLogs.reduce((s, g) => s + g.points,   0) / n).toFixed(1),
    reb:  +(gameLogs.reduce((s, g) => s + g.rebounds, 0) / n).toFixed(1),
    ast:  +(gameLogs.reduce((s, g) => s + g.assists,  0) / n).toFixed(1),
    stl:  +(gameLogs.reduce((s, g) => s + g.steals,   0) / n).toFixed(1),
    blk:  +(gameLogs.reduce((s, g) => s + g.blocks,   0) / n).toFixed(1),
    fg3m: +(gameLogs.reduce((s, g) => s + g.fg3m,     0) / n).toFixed(1),
    pra:  +(gameLogs.reduce((s, g) => s + g.pra,      0) / n).toFixed(1),
  } : null

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
              <span className="text-white/50">vs {opponent}</span>
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

      {/* ── Stat averages ── */}
      {avg && (
        <div>
          <p className="text-xs font-semibold text-white/35 uppercase tracking-wider mb-3">
            L{n} Averages
          </p>
          <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
            {([
              ['PTS',  avg.pts],
              ['REB',  avg.reb],
              ['AST',  avg.ast],
              ['STL',  avg.stl],
              ['BLK',  avg.blk],
              ['3PM',  avg.fg3m],
              ['PRA',  avg.pra],
            ] as [string, number][]).map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl bg-white/[0.04] border border-white/[0.07] p-3 text-center"
              >
                <div className="text-xl font-bold text-white">{value}</div>
                <div className="text-xs text-white/35 mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Today's props ── */}
      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-white">Today&apos;s Props</h2>

        {playerProps.length > 0 ? playerProps.map((prop, i) => {
          const chartData = gameLogs.map((g) => ({
            date: formatDate(g.date),
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

                  {/* Direction pill */}
                  <span className={[
                    'text-sm font-semibold px-3 py-0.5 rounded-full',
                    prop.direction === 'over'
                      ? 'bg-blue-500/15 text-blue-400'
                      : 'bg-orange-500/15 text-orange-400',
                  ].join(' ')}>
                    {prop.direction.toUpperCase()} {prop.line}
                  </span>

                  {/* L10 hit rate */}
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

              {/* AI reasoning */}
              {prop.confidence_reason && (
                <p className="text-sm text-white/45 leading-relaxed">{prop.confidence_reason}</p>
              )}

              {/* Chart */}
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
            <p className="text-white/25 text-xs mt-1">Props are populated when today&apos;s games are seeded.</p>
          </div>
        )}
      </div>

      {/* ── Recent game log ── */}
      {gameLogs.length > 0 && (
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
                {gameLogs.map((g, i) => (
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
