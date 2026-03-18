import { supabase } from '@/lib/supabase'
import { searchPlayer, fetchPlayerRecentStats, fetchSeasonAverages } from '@/lib/nba-api'
import { ConfidenceBadge } from '@/components/ConfidenceBadge'
import { StatChart } from '@/components/StatChart'
import Link from 'next/link'
import type { Prop, StatType } from '@/types'

export const revalidate = 0

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

function getStatValue(game: Record<string, number>, statType: StatType): number {
  switch (statType) {
    case 'points': return game.points
    case 'rebounds': return game.rebounds
    case 'assists': return game.assists
    case 'steals': return game.steals
    case 'blocks': return game.blocks
    case 'three_pointers': return game.three_pointers
    case 'pra': return game.points + game.rebounds + game.assists
    default: return 0
  }
}

export default async function PlayerPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const playerName = decodeURIComponent(name)

  // Fetch player's props from Supabase
  const { data: props } = await supabase
    .from('props')
    .select('*')
    .ilike('player_name', playerName)
    .order('confidence_score', { ascending: false, nullsFirst: false })

  const playerProps = (props ?? []) as Prop[]

  // Fetch recent game logs from NBA.com
  const player = await searchPlayer(playerName)
  const recentGames = player ? await fetchPlayerRecentStats(player.id, 10).catch(() => []) : []
  const seasonAvg = player ? await fetchSeasonAverages(player.id).catch(() => null) : null

  const gameRows = recentGames.map((g) => ({
    date: String(g.date).replace(/,\s*\d{4}/, '').trim(), // "Mar 16"
    points: g.pts ?? 0,
    rebounds: g.reb ?? 0,
    assists: g.ast ?? 0,
    steals: g.stl ?? 0,
    blocks: g.blk ?? 0,
    three_pointers: g.fg3m ?? 0,
  }))

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
      {/* Back */}
      <Link href="/" className="text-sm text-white/40 hover:text-white/70 transition-colors">
        ← Back to all props
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-bold text-white">{playerName}</h1>
        {player && (
          <p className="text-white/40 text-sm">{player.team.full_name} · {player.team.abbreviation}</p>
        )}
      </div>

      {/* Season averages */}
      {seasonAvg && (
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-3">
          {[
            { label: 'PTS', value: seasonAvg.pts },
            { label: 'REB', value: seasonAvg.reb },
            { label: 'AST', value: seasonAvg.ast },
            { label: 'STL', value: seasonAvg.stl },
            { label: 'BLK', value: seasonAvg.blk },
            { label: '3PM', value: seasonAvg.fg3m },
            { label: 'MIN', value: parseFloat(seasonAvg.min) },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl bg-white/5 border border-white/10 p-3 text-center">
              <div className="text-xl font-bold text-white">{value.toFixed(1)}</div>
              <div className="text-xs text-white/40 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Per-prop charts */}
      {playerProps.length > 0 ? (
        <div className="flex flex-col gap-6">
          <h2 className="text-lg font-semibold text-white">Today&apos;s Props</h2>
          {playerProps.map((prop, i) => {
            const chartData = gameRows.map((g) => ({
              date: g.date,
              value: getStatValue(g as Record<string, number>, prop.stat_type),
            }))

            return (
              <div key={prop.id ?? i} className="rounded-xl border border-white/10 bg-white/[0.03] p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-3">
                    <span className="text-white font-semibold">
                      {prop.direction.toUpperCase()} {prop.line} {STAT_LABELS[prop.stat_type]}
                    </span>
                    {prop.sportsbook && (
                      <span className="text-xs text-white/30">{prop.sportsbook}</span>
                    )}
                  </div>
                  {prop.confidence_label && prop.confidence_score != null && (
                    <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                  )}
                </div>

                {prop.confidence_reason && (
                  <p className="text-sm text-white/40">{prop.confidence_reason}</p>
                )}

                {chartData.length > 0 ? (
                  <StatChart
                    games={chartData}
                    line={prop.line}
                    statLabel={STAT_LABELS[prop.stat_type]}
                    direction={prop.direction}
                  />
                ) : (
                  <div className="h-24 flex items-center justify-center text-white/20 text-sm">
                    No recent game data available
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-white/40">No props found for {playerName} today.</p>
      )}
    </div>
  )
}
