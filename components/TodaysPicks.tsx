import { supabase } from '@/lib/supabase'
import Link from 'next/link'

const STAT_LABELS: Record<string, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

interface ParlayLeg {
  player_name: string
  team?: string
  stat_type: string
  line: number
  direction: string
  confidence_label?: string
  confidence_score?: number
}

interface Parlay {
  id: string
  title: string
  parlay_type: string
  est_multiplier: number | null
  legs: ParlayLeg[]
  pass?: 1 | 2 | null
  change_summary?: string | null
}

const TYPE_BADGE: Record<string, { label: string; style: string }> = {
  value:   { label: 'Safe Pick',   style: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25' },
  combo:   { label: 'Combo',       style: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/25' },
  premium: { label: 'High Roller', style: 'text-[#e8a820] bg-[#e8a820]/10 border-[#e8a820]/25' },
  jackpot: { label: 'Jackpot',     style: 'text-violet-400 bg-violet-400/10 border-violet-400/25' },
}

function labelStyle(label: string | undefined) {
  if (label === 'LOCK') return 'text-violet-400 bg-violet-400/10 border-violet-400/25'
  if (label === 'PLAY') return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
  return 'text-white/40 bg-white/5 border-white/10'
}

export async function TodaysPicks() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  const { data } = await supabase
    .from('curated_parlays')
    .select('id, title, parlay_type, est_multiplier, legs, pass, change_summary')
    .eq('game_date', today)
    .eq('active', true)
    .or('superseded.is.null,superseded.eq.false')
    .in('parlay_type', ['value', 'combo', 'premium', 'jackpot'])
    .order('created_at', { ascending: false })
    .limit(4)

  const parlays = (data ?? []) as Parlay[]
  if (parlays.length === 0) return null

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />
      <div className="p-4 sm:p-5 flex flex-col gap-4">

        <div className="flex items-center justify-between">
          <p className="text-sm font-black text-white">Today&apos;s Picks</p>
          <Link
            href="/feed"
            className="text-[11px] text-[#f0c060] font-semibold hover:text-[#e8a820] transition-colors flex items-center gap-1"
          >
            View all
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>

        <div className="flex flex-col gap-3">
          {parlays.map((parlay) => {
            const badge = TYPE_BADGE[parlay.parlay_type]
            return (
              <div key={parlay.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {badge && (
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge.style}`}>
                        {badge.label}
                      </span>
                    )}
                    {parlay.pass === 2 && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border text-amber-400 bg-amber-400/10 border-amber-400/25">
                        UPDATED
                      </span>
                    )}
                    <span className="text-xs text-white/25">{parlay.legs.length} legs</span>
                  </div>
                  {parlay.est_multiplier != null && (
                    <span className="text-sm font-black text-[#f0c060]">~{parlay.est_multiplier}x</span>
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  {parlay.legs.slice(0, 3).map((leg, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 bg-white/[0.02] border border-white/[0.05]"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-xs font-semibold text-white/70 truncate">
                          {leg.player_name}
                        </p>
                        <p className="text-[11px] text-white/30 shrink-0">
                          <span className={leg.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}>
                            {leg.direction === 'over' ? 'O' : 'U'}
                          </span>
                          {leg.line} {STAT_LABELS[leg.stat_type] ?? leg.stat_type}
                        </p>
                      </div>
                      {leg.confidence_label && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${labelStyle(leg.confidence_label)}`}>
                          {leg.confidence_score != null ? Math.round(leg.confidence_score) : ''} {leg.confidence_label}
                        </span>
                      )}
                    </div>
                  ))}
                  {parlay.legs.length > 3 && (
                    <p className="text-[10px] text-white/20 text-center">+{parlay.legs.length - 3} more</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
