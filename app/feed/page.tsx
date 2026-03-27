import Link from 'next/link'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const STAT_LABELS: Record<string, string> = {
  points:         'PTS',
  rebounds:       'REB',
  assists:        'AST',
  steals:         'STL',
  blocks:         'BLK',
  three_pointers: '3PM',
  pra:            'PRA',
}

interface FeedLeg {
  player_name:       string
  team:              string
  stat_type:         string
  line:              number
  direction:         'over' | 'under'
  odds?:             number
  confidence_label?: string
  confidence_score?: number
  l10_hits?:         number
  l10_total?:        number
  l5_hits?:          number
  l5_total?:         number
}

interface CuratedParlay {
  id:             string
  title:          string
  description?:   string | null
  parlay_type:    'sgp' | 'multi' | 'premium' | 'value' | 'jackpot' | 'streak'
  game_date:      string
  est_multiplier?: number | null
  legs:           FeedLeg[]
  created_at:     string
  active:         boolean
  result?:        'hit' | 'miss' | 'void' | null
}

interface StreakState {
  currentStreak: number          // consecutive days both picks hit
  history:       CuratedParlay[] // last 10 streak entries, newest first
  todayPick:     CuratedParlay | null
}

async function getFeedData(): Promise<{ parlays: CuratedParlay[]; streakState: StreakState }> {
  const { data, error } = await supabase
    .from('curated_parlays')
    .select('*')
    .eq('active', true)
    .in('parlay_type', ['value', 'premium', 'jackpot', 'streak'])
    .order('game_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(70)

  if (error) {
    if (error.code === '42P01') return { parlays: [], streakState: { currentStreak: 0, history: [], todayPick: null } }
    console.error('[feed] Supabase error:', error.message)
    return { parlays: [], streakState: { currentStreak: 0, history: [], todayPick: null } }
  }

  const all     = (data ?? []) as CuratedParlay[]
  const parlays = all.filter((p) => p.parlay_type !== 'streak')
  const streaks = all.filter((p) => p.parlay_type === 'streak')
    .sort((a, b) => b.game_date.localeCompare(a.game_date))

  // Compute streak: walk history from most recent graded day, count consecutive hits
  const today    = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const todayPick = streaks.find((s) => s.game_date === today) ?? null
  const graded   = streaks.filter((s) => s.game_date < today && s.result != null)

  let currentStreak = 0
  for (const s of graded) {
    if (s.result === 'hit') currentStreak++
    else break  // miss or void resets streak
  }

  return {
    parlays,
    streakState: { currentStreak, history: streaks.slice(0, 10), todayPick },
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const target    = new Date(dateStr + 'T00:00:00')
  if (target.getTime() === today.getTime())     return 'Today'
  if (target.getTime() === yesterday.getTime()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatPostedAt(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET'
}

function labelStyle(label: string | undefined) {
  if (label === 'LOCK') return 'text-violet-400 bg-violet-400/10 border-violet-400/25'
  if (label === 'PLAY') return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
  if (label === 'LEAN') return 'text-yellow-400 bg-yellow-400/10 border-yellow-400/25'
  return 'text-white/40 bg-white/5 border-white/10'
}

function oddsStr(odds: number | undefined): string {
  if (odds == null) return '−110'
  return odds > 0 ? `+${odds}` : `${odds}`
}

function resultBadge(result?: 'hit' | 'miss' | 'void' | null) {
  if (!result) return null
  if (result === 'hit')  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border text-emerald-400 bg-emerald-400/10 border-emerald-400/25">✓ HIT</span>
  if (result === 'miss') return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border text-red-400 bg-red-400/10 border-red-400/25">✗ MISS</span>
  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border text-white/30 bg-white/5 border-white/10">VOID</span>
}

export default async function FeedPage() {
  const { parlays, streakState } = await getFeedData()
  const { currentStreak, history, todayPick } = streakState

  // Group parlays by game_date
  const byDate = new Map<string, CuratedParlay[]>()
  for (const p of parlays) {
    if (!byDate.has(p.game_date)) byDate.set(p.game_date, [])
    byDate.get(p.game_date)!.push(p)
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a))

  // Build 10-bubble state from history (newest = rightmost bubble)
  // bubbles[0] = oldest, bubbles[9] = today
  const TOTAL = 10
  const bubbles: Array<'hit' | 'miss' | 'pending' | 'empty'> = Array(TOTAL).fill('empty')
  // Each day = 2 bubbles (one per pick). 10 bubbles = 5 days.
  const orderedHistory = [...history].reverse() // oldest first → fills left to right
  orderedHistory.forEach((s, dayIndex) => {
    const b0 = dayIndex * 2
    const b1 = dayIndex * 2 + 1
    if (b0 >= TOTAL) return
    const state: 'hit' | 'miss' | 'pending' =
      s.result === 'hit' ? 'hit' : s.result === 'miss' ? 'miss' : 'pending'
    bubbles[b0] = state
    if (b1 < TOTAL) bubbles[b1] = state
  })

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">

      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-white">Feed</h1>
        <p className="text-white/40 text-sm">Daily streaks and curated parlays</p>
      </div>

      {/* Streak Tracker */}
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
        <div className="h-px w-full bg-gradient-to-r from-transparent via-orange-400/40 to-transparent" />
        <div className="p-5 flex flex-col gap-4">

          {/* Streak header */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-base font-black text-white">Daily Streak</p>
              <p className="text-xs text-white/35 mt-0.5">Pick 2 every day · both must hit to continue</p>
            </div>
            <div className="text-right">
              <p className="text-3xl font-black text-orange-400">{currentStreak}</p>
              <p className="text-[10px] text-white/30 uppercase tracking-widest">streak</p>
            </div>
          </div>

          {/* 10 bubbles */}
          <div className="flex items-center gap-1.5">
            {bubbles.map((state, i) => (
              <div
                key={i}
                className={`flex-1 h-2.5 rounded-full transition-colors ${
                  state === 'hit'     ? 'bg-emerald-400'
                  : state === 'miss'  ? 'bg-red-500/60'
                  : state === 'pending' ? 'bg-orange-400/50 animate-pulse'
                  : 'bg-white/[0.08]'
                }`}
              />
            ))}
          </div>

          {/* Today's picks */}
          {todayPick ? (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] text-white/25 uppercase tracking-widest font-semibold">Today&apos;s Picks</p>
              <div className="flex flex-col gap-1.5">
                {(todayPick.legs as FeedLeg[]).map((leg, i) => (
                  <Link
                    key={i}
                    href={`/player/${encodeURIComponent(leg.player_name)}`}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] hover:border-white/[0.12] transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-white truncate">
                        {leg.player_name}
                        {leg.team && <span className="text-[11px] text-white/25 font-normal ml-1.5">{leg.team}</span>}
                      </p>
                      <p className="text-xs text-white/40 mt-0.5">
                        <span className={`font-bold ${leg.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {leg.direction.toUpperCase()}
                        </span>
                        {' '}{leg.line} {STAT_LABELS[leg.stat_type] ?? leg.stat_type}
                        <span className="ml-2 text-[#f0c060]/50 font-semibold">{oddsStr(leg.odds)}</span>
                      </p>
                    </div>
                    {leg.confidence_label && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${labelStyle(leg.confidence_label)}`}>
                        {leg.confidence_score != null ? Math.round(leg.confidence_score) : ''} {leg.confidence_label}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
              {todayPick.result && (
                <div className="flex justify-center pt-1">
                  {resultBadge(todayPick.result)}
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-white/25 text-center py-2">Today&apos;s picks generate after morning props refresh</p>
          )}
        </div>
      </div>

      {parlays.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-16 text-center flex flex-col gap-3">
          <p className="text-white/40 text-sm font-semibold">No parlays posted yet</p>
          <p className="text-white/20 text-xs max-w-xs mx-auto leading-relaxed">
            Auto-curated parlays are generated daily after props are pulled. Check back soon.
          </p>
        </div>
      ) : dates.map((date) => (
        <div key={date} className="flex flex-col gap-3">

          {/* Date header */}
          <div className="flex items-center gap-3">
            <p className="text-xs text-white/30 uppercase tracking-widest font-semibold">{formatDate(date)}</p>
            <div className="flex-1 h-px bg-white/[0.06]" />
          </div>

          {/* Parlay cards — value first, then premium, then jackpot */}
          {[...byDate.get(date)!].sort((a, b) => {
            const order = (t: string) => t === 'value' ? 0 : t === 'premium' ? 1 : t === 'jackpot' ? 2 : 3
            return order(a.parlay_type) - order(b.parlay_type)
          }).map((parlay) => (
            <div key={parlay.id} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
              <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/35 to-transparent" />

              <div className="p-4 sm:p-5 flex flex-col gap-3">

                {/* Parlay header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-base font-black text-white">{parlay.title}</p>
                      {resultBadge(parlay.result)}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border
                        ${parlay.parlay_type === 'sgp'     ? 'text-blue-400 bg-blue-400/10 border-blue-400/25'
                        : parlay.parlay_type === 'value'   ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
                        : parlay.parlay_type === 'premium' ? 'text-[#e8a820] bg-[#e8a820]/10 border-[#e8a820]/25'
                        : parlay.parlay_type === 'jackpot' ? 'text-violet-400 bg-violet-400/10 border-violet-400/25'
                        :                                    'text-white/40 bg-white/5 border-white/10'}`}>
                        {parlay.parlay_type === 'sgp'     ? 'SGP'
                          : parlay.parlay_type === 'value'   ? 'Consistent'
                          : parlay.parlay_type === 'premium' ? 'High Roller'
                          : parlay.parlay_type === 'jackpot' ? 'Jackpot'
                          : 'Multi'}
                      </span>
                    </div>
                    {parlay.description && (
                      <p className="text-sm text-white/45 mt-1 leading-snug">{parlay.description}</p>
                    )}
                    <p className="text-[11px] text-white/20 mt-1.5">
                      Posted {formatPostedAt(parlay.created_at)}
                    </p>
                  </div>

                  {parlay.est_multiplier != null && (
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-white/30 uppercase tracking-widest">Est. Payout</p>
                      <p className="text-2xl font-black text-[#f0c060]">~{parlay.est_multiplier.toFixed(1)}×</p>
                    </div>
                  )}
                </div>

                {/* Legs */}
                <div className="flex flex-col gap-1.5">
                  {(parlay.legs as FeedLeg[]).map((leg, i) => (
                    <Link
                      key={`${leg.player_name}-${leg.stat_type}-${i}`}
                      href={`/player/${encodeURIComponent(leg.player_name)}`}
                      className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] hover:border-white/[0.12] transition-colors"
                    >
                      <span className="text-xs font-black text-white/15 w-3 shrink-0">{i + 1}</span>

                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-white truncate">
                          {leg.player_name}
                          {leg.team && (
                            <span className="text-[11px] text-white/25 font-normal ml-1.5">{leg.team}</span>
                          )}
                        </p>
                        <p className="text-xs text-white/40 mt-0.5">
                          <span className={`font-bold ${leg.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {leg.direction.toUpperCase()}
                          </span>
                          {' '}{leg.line} {STAT_LABELS[leg.stat_type] ?? leg.stat_type}
                          <span className="ml-2 text-[#f0c060]/50 font-semibold">{oddsStr(leg.odds)}</span>
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {leg.l10_hits != null && leg.l10_total != null && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border text-emerald-400 bg-emerald-400/10 border-emerald-400/20 whitespace-nowrap">
                            {leg.l10_hits}/{leg.l10_total} L{leg.l10_total}
                          </span>
                        )}
                        {leg.confidence_label && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${labelStyle(leg.confidence_label)}`}>
                            {leg.confidence_score != null ? Math.round(leg.confidence_score) : ''} {leg.confidence_label}
                          </span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>

                {/* Footer note */}
                <p className="text-[10px] text-white/15">
                  {parlay.legs.length}-leg {parlay.parlay_type === 'sgp' ? 'same-game parlay' : 'cross-game parlay'}
                  {parlay.parlay_type === 'value'   ? ' · Consistent Pick · PTS/REB/AST/3PM · LOCK+PLAY' : ''}
                  {parlay.parlay_type === 'premium' ? ' · High Roller · PTS/REB/AST/3PM · 24+ min avg' : ''}
                  {parlay.parlay_type === 'jackpot' ? ' · Jackpot · PTS/REB/AST/3PM · 24+ min avg · ~17x' : ''}
                  {parlay.est_multiplier != null ? ` · est. ~${parlay.est_multiplier.toFixed(1)}× payout` : ''}
                </p>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
