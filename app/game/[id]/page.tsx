import { supabase } from '@/lib/supabase'
import { ConfidenceBadge } from '@/components/ConfidenceBadge'
import Link from 'next/link'
import type { Prop, StatType } from '@/types'

export const revalidate = 0

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
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
  return [...best.values()].sort(
    (a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0),
  )
}

async function getGameProps(gameId: string): Promise<Prop[]> {
  const { data, error } = await supabase
    .from('props')
    .select('*')
    .eq('game_id', gameId)
    .order('confidence_score', { ascending: false, nullsFirst: false })

  if (error) {
    console.error('[game] Supabase error:', error.message)
    return []
  }
  return deduplicateProps((data ?? []) as Prop[])
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

  // Extract team names and game time from props (any prop will do)
  const sample = props[0]
  const homeTeam = sample?.home_team ?? null
  const awayTeam = sample?.away_team ?? null
  const commenceTime = sample?.commence_time ?? null

  const matchupLabel =
    homeTeam && awayTeam
      ? `${awayTeam} @ ${homeTeam}`
      : `Game ${gameId}`

  const high = props.filter((p) => p.confidence_label === 'HIGH').length
  const medium = props.filter((p) => p.confidence_label === 'MEDIUM').length
  const low = props.filter((p) => p.confidence_label === 'LOW').length

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
          <div className="px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
            <span className="text-green-400 font-semibold">{high}</span>
            <span className="text-white/40 ml-1.5">High confidence</span>
          </div>
          <div className="px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm">
            <span className="text-yellow-400 font-semibold">{medium}</span>
            <span className="text-white/40 ml-1.5">Medium confidence</span>
          </div>
          <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
            <span className="text-red-400 font-semibold">{low}</span>
            <span className="text-white/40 ml-1.5">Low confidence</span>
          </div>
        </div>
      )}

      {/* Props table */}
      {props.length === 0 ? (
        <div className="py-20 text-center text-white/30">
          No scored props found for this game.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5 text-white/50 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Player</th>
                <th className="px-4 py-3 text-left">Stat</th>
                <th className="px-4 py-3 text-right">Line</th>
                <th className="px-4 py-3 text-left">Dir</th>
                <th className="px-4 py-3 text-left">Confidence</th>
                <th className="px-4 py-3 text-left">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {props.map((prop, i) => (
                <tr
                  key={prop.id ?? i}
                  className="hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-3 font-medium text-white">
                    <Link
                      href={`/player/${encodeURIComponent(prop.player_name)}`}
                      className="hover:text-blue-400 transition-colors"
                    >
                      {prop.player_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-white/60">
                    {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-white">
                    {prop.line}
                  </td>
                  <td className="px-4 py-3">
                    <span className={prop.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}>
                      {prop.direction.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {prop.confidence_label && prop.confidence_score != null ? (
                      <ConfidenceBadge
                        label={prop.confidence_label}
                        score={prop.confidence_score}
                      />
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/40 text-xs max-w-xs truncate">
                    {prop.confidence_reason ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
