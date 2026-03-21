import { supabase } from '@/lib/supabase'
import GamePropsTable from '@/components/GamePropsTable'
import Link from 'next/link'
import type { AltLine, Prop, PropWithAlts } from '@/types'

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

  const TIER_ORDER: Record<string, number> = { LOCK: 0, PLAY: 1, LEAN: 2, FADE: 3 }
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

  const lock = props.filter((p) => p.confidence_label === 'LOCK').length
  const play = props.filter((p) => p.confidence_label === 'PLAY').length
  const lean = props.filter((p) => p.confidence_label === 'LEAN').length
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
          <div className="px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm">
            <span className="text-yellow-400 font-semibold">{lean}</span>
            <span className="text-white/40 ml-1.5">Lean</span>
          </div>
          <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
            <span className="text-red-400 font-semibold">{fade}</span>
            <span className="text-white/40 ml-1.5">Fade</span>
          </div>
        </div>
      )}

      {/* Props list */}
      {props.length === 0 ? (
        <div className="py-20 text-center text-white/30">
          No props found for this game.
        </div>
      ) : (
        <GamePropsTable props={props} />
      )}
    </div>
  )
}
