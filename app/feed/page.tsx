import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { calibratedPct } from '@/lib/calibration'

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
  parlay_type:    'sgp' | 'multi' | 'premium' | 'value' | 'combo' | 'jackpot' | 'streak'
  game_date:      string
  est_multiplier?: number | null
  legs:           FeedLeg[]
  created_at:     string
  active:         boolean
  result?:        'hit' | 'miss' | 'void' | null
  pass?:          1 | 2 | null
  replaces_id?:   string | null
  change_summary?: string | null
  superseded?:    boolean
}

interface FeedAnnouncement {
  id:         string
  game_date:  string
  message:    string
  type:       string
  created_at: string
}

interface StreakState {
  currentStreak: number          // consecutive days both picks hit
  history:       CuratedParlay[] // last 10 streak entries, newest first
  todayPick:     CuratedParlay | null
}

async function getFeedData(): Promise<{ parlays: CuratedParlay[]; streakState: StreakState; announcements: FeedAnnouncement[] }> {
  // Only show the final version of each parlay (non-superseded)
  const [parlayRes, announcementRes] = await Promise.all([
    supabase
      .from('curated_parlays')
      .select('*')
      .eq('active', true)
      .or('superseded.is.null,superseded.eq.false')
      .in('parlay_type', ['value', 'combo', 'premium', 'jackpot', 'streak'])
      .order('game_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(70),
    supabase
      .from('feed_announcements')
      .select('*')
      .order('game_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(30),
  ])

  const { data, error } = parlayRes
  const emptyState = { parlays: [], streakState: { currentStreak: 0, history: [], todayPick: null }, announcements: [] }

  if (error) {
    if (error.code === '42P01') return emptyState
    console.error('[feed] Supabase error:', error.message)
    return emptyState
  }

  const announcements = (announcementRes?.data ?? []) as FeedAnnouncement[]
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
    announcements,
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
  if (label === 'LOCK') return 'text-[#00D68F] bg-[#00D68F]/10 border-[#00D68F]/25'
  if (label === 'PLAY') return 'text-[#FFB800] bg-[#FFB800]/10 border-[#FFB800]/25'
  if (label === 'LEAN') return 'text-[#3B82F6] bg-[#3B82F6]/10 border-[#3B82F6]/25'
  return 'text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border-[var(--border-default)]'
}

function oddsStr(odds: number | undefined): string {
  if (odds == null) return '−110'
  return odds > 0 ? `+${odds}` : `${odds}`
}

function resultBadge(result?: 'hit' | 'miss' | 'void' | null) {
  if (!result) return null
  if (result === 'hit')  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border text-[#00D68F] bg-[#00D68F]/10 border-[#00D68F]/25">HIT</span>
  if (result === 'miss') return <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border text-[#FF4757] bg-[#FF4757]/10 border-[#FF4757]/25">MISS</span>
  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border-[var(--border-default)]">VOID</span>
}

export default async function FeedPage() {
  const { parlays, streakState, announcements } = await getFeedData()
  const { currentStreak, history, todayPick } = streakState

  // Group announcements by game_date
  const announcementsByDate = new Map<string, FeedAnnouncement[]>()
  for (const a of announcements) {
    if (!announcementsByDate.has(a.game_date)) announcementsByDate.set(a.game_date, [])
    announcementsByDate.get(a.game_date)!.push(a)
  }

  // Group parlays by game_date
  const byDate = new Map<string, CuratedParlay[]>()
  for (const p of parlays) {
    if (!byDate.has(p.game_date)) byDate.set(p.game_date, [])
    byDate.get(p.game_date)!.push(p)
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a))

  // Build 10-bar tracker: hits fill from the RIGHT, today's pending sits just
  // after the last hit, and empty bars fill the LEFT.
  // Example with 2 streak + pending today: [empty][empty][...][green][green][orange]
  const TOTAL = 10
  const todayState: 'pending' | 'hit' | 'empty' =
    todayPick && todayPick.result === 'hit' ? 'hit'
    : todayPick && (todayPick.result == null || todayPick.result === undefined) ? 'pending'
    : 'empty'

  // Count consecutive past hits (the current streak)
  let streakHits = 0
  for (const s of history) {
    if (s.game_date >= new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })) continue
    if (s.result !== 'hit') break
    streakHits++
    if (streakHits >= TOTAL) break
  }

  // Fill from the right: [empty...] [hits...] [today]
  const hasToday = todayState !== 'empty' ? 1 : 0
  const filledCount = Math.min(streakHits + hasToday, TOTAL)
  const emptyCount  = TOTAL - filledCount

  const bars: Array<'hit' | 'miss' | 'pending' | 'empty'> = []
  for (let i = 0; i < emptyCount; i++) bars.push('empty')
  for (let i = 0; i < Math.min(streakHits, TOTAL - hasToday); i++) bars.push('hit')
  if (hasToday) bars.push(todayState)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">

      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Feed</h1>
        <p className="text-[var(--text-tertiary)] text-sm">Daily streaks and curated parlays</p>
      </div>

      {/* Streak Tracker — compact single-row bar */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[var(--text-secondary)]">Daily Streak</span>
          <div className="flex items-center gap-1">
            {bars.map((state, i) => (
              <div
                key={i}
                className={`w-4 h-4 rounded-sm transition-colors ${
                  state === 'hit'     ? 'bg-[#00D68F]'
                  : state === 'miss'  ? 'bg-[#FF4757]'
                  : state === 'pending' ? 'bg-[#FFB800]'
                  : 'bg-[var(--bg-surface-2)] border border-[var(--border-default)]'
                }`}
              />
            ))}
          </div>
        </div>
        <span className="text-lg font-black text-[#00D68F] font-mono">{currentStreak}</span>
      </div>

      {parlays.length === 0 ? (
        <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl p-16 text-center flex flex-col gap-3">
          <p className="text-[var(--text-secondary)] text-sm font-semibold">No parlays posted yet</p>
          <p className="text-[var(--text-tertiary)] text-xs max-w-xs mx-auto leading-relaxed">
            Auto-curated parlays are generated daily after props are pulled. Check back soon.
          </p>
        </div>
      ) : dates.map((date) => (
        <div key={date} className="flex flex-col gap-3">

          {/* Date header */}
          <div className="flex items-center gap-3">
            <p className="text-xs text-[var(--text-tertiary)] uppercase tracking-widest font-semibold">{formatDate(date)}</p>
            <div className="flex-1 h-px bg-[var(--border-subtle)]" />
          </div>

          {/* Announcements for this date */}
          {(announcementsByDate.get(date) ?? []).map((ann) => (
            <div key={ann.id} className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden">
              <div className={`h-px w-full bg-gradient-to-r from-transparent ${
                ann.type === 'pass2_update' ? 'via-[#FFB800]/40' : 'via-[#3B82F6]/30'
              } to-transparent`} />
              <div className="p-4 sm:p-5 flex items-start gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                  ann.type === 'pass2_update'
                    ? 'bg-[#FFB800]/10 text-[#FFB800]'
                    : 'bg-[#3B82F6]/10 text-[#3B82F6]'
                }`}>
                  {ann.type === 'pass2_update' ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-widest font-semibold mb-1">Prizm Update</p>
                  <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{ann.message}</p>
                  <p className="text-[10px] text-[var(--text-tertiary)] mt-1.5">{formatPostedAt(ann.created_at)}</p>
                </div>
              </div>
            </div>
          ))}

          {/* Parlay cards — value first, combo, then premium, then jackpot */}
          {[...byDate.get(date)!].sort((a, b) => {
            const order = (t: string) => t === 'value' ? 0 : t === 'combo' ? 1 : t === 'premium' ? 2 : t === 'jackpot' ? 3 : 4
            return order(a.parlay_type) - order(b.parlay_type)
          }).map((parlay) => {
            const isPremiumTier = parlay.parlay_type === 'premium' || parlay.parlay_type === 'jackpot'
            return (
              <div
                key={parlay.id}
                className={`bg-[var(--bg-surface)] border rounded-xl overflow-hidden shadow-[var(--shadow-card)] ${
                  isPremiumTier ? 'border-primary/30' : 'border-[var(--border-default)]'
                }`}
              >
                {/* Pass 2 update banner */}
                {parlay.pass === 2 && parlay.change_summary && (
                  <div className="flex items-start gap-2.5 px-4 py-2.5 bg-[#FFB800]/[0.06] border-b border-[#FFB800]/15">
                    <svg className="w-3.5 h-3.5 text-[#FFB800] shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <p className="text-[11px] text-[#FFB800]/80 leading-snug">
                      <span className="font-bold text-[#FFB800]">Updated at 11 AM ET</span>
                      {' \u2014 '}{parlay.change_summary}
                    </p>
                  </div>
                )}

                {/* Card header */}
                <div className="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <p className="text-base font-black text-[var(--text-primary)]">{parlay.title}</p>
                    {resultBadge(parlay.result)}
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border
                      ${parlay.parlay_type === 'sgp'     ? 'text-[#3B82F6] bg-[#3B82F6]/10 border-[#3B82F6]/25'
                      : parlay.parlay_type === 'value'   ? 'text-[#00D68F] bg-[#00D68F]/10 border-[#00D68F]/25'
                      : parlay.parlay_type === 'combo'   ? 'text-[#3B82F6] bg-[#3B82F6]/10 border-[#3B82F6]/25'
                      : parlay.parlay_type === 'premium' ? 'text-[#FFB800] bg-[#FFB800]/10 border-[#FFB800]/25'
                      : parlay.parlay_type === 'jackpot' ? 'text-[#A29BFE] bg-[#A29BFE]/10 border-[#A29BFE]/25'
                      :                                    'text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border-[var(--border-default)]'}`}>
                      {parlay.parlay_type === 'sgp'     ? 'SGP'
                        : parlay.parlay_type === 'value'   ? 'Safe Pick'
                        : parlay.parlay_type === 'combo'   ? 'Combo'
                        : parlay.parlay_type === 'premium' ? 'High Roller'
                        : parlay.parlay_type === 'jackpot' ? 'Jackpot'
                        : 'Multi'}
                    </span>
                    {parlay.est_multiplier != null && (
                      <span className="bg-primary/15 text-[#A29BFE] px-2 py-0.5 rounded-md text-xs font-semibold font-mono">
                        ~{parlay.est_multiplier.toFixed(1)}×
                      </span>
                    )}
                  </div>
                  <div className="shrink-0 text-right ml-3">
                    {parlay.description && (
                      <p className="text-[11px] text-[var(--text-tertiary)] leading-snug">{parlay.description}</p>
                    )}
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                      Posted {formatPostedAt(parlay.created_at)}
                    </p>
                  </div>
                </div>

                {/* Legs */}
                <div className="flex flex-col">
                  {(parlay.legs as FeedLeg[]).map((leg, i) => (
                    <Link
                      key={`${leg.player_name}-${leg.stat_type}-${i}`}
                      href={`/player/${encodeURIComponent(leg.player_name)}`}
                      className="px-4 py-2.5 flex items-center justify-between border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-surface-2)] transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xs font-black text-[var(--text-tertiary)] w-3 shrink-0">{i + 1}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-[var(--text-primary)] truncate">
                            {leg.player_name}
                            {leg.team && leg.team !== 'TBD' && (
                              <span className="text-[11px] text-[var(--text-tertiary)] font-normal ml-1.5">{leg.team}</span>
                            )}
                          </p>
                          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                            <span className={`font-bold ${leg.direction === 'over' ? 'text-[#00D68F]' : 'text-[#FF4757]'}`}>
                              {leg.direction.toUpperCase()}
                            </span>
                            {' '}{leg.line} {STAT_LABELS[leg.stat_type] ?? leg.stat_type}
                            <span className="ml-2 text-[#FFB800]/50 font-semibold">{oddsStr(leg.odds)}</span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {leg.l10_hits != null && leg.l10_total != null && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border text-[#00D68F] bg-[#00D68F]/10 border-[#00D68F]/20 whitespace-nowrap">
                            {leg.l10_hits}/{leg.l10_total} L{leg.l10_total}
                          </span>
                        )}
                        {leg.confidence_label && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${labelStyle(leg.confidence_label)}`}>
                            {calibratedPct(leg.confidence_score) ?? ''} {leg.confidence_label}
                          </span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>

              </div>
            )
          })}
        </div>
      ))}

      {/* How Prizm Feed Works — explainer */}
      <details className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden">
        <summary className="p-4 cursor-pointer select-none flex items-center justify-between">
          <span className="text-sm font-bold text-[var(--text-secondary)]">How Prizm Feed Works</span>
          <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider">tap to expand</span>
        </summary>
        <div className="px-4 pb-4 text-xs text-[var(--text-secondary)] leading-relaxed flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-3">
          <div>
            <p className="font-bold text-[var(--text-secondary)] mb-0.5">5 AM ET &mdash; Morning Picks</p>
            <p>
              Our model scores every available prop using game logs, defense matchups,
              and historical trends. The top picks become your daily Safe Pick, Combo,
              High Roller, and Jackpot parlays.
            </p>
          </div>
          <div>
            <p className="font-bold text-[var(--text-secondary)] mb-0.5">11 AM ET &mdash; Midday Re-evaluation</p>
            <p>
              We re-check all morning picks against updated injury reports and line movements.
              If a key player is ruled out or a line has shifted significantly, we generate
              updated picks marked with an amber banner explaining what changed.
            </p>
          </div>
          <div>
            <p className="font-bold text-[var(--text-secondary)] mb-0.5">Performance Tracking</p>
            <p>
              Only the final version of each parlay (updated if available, otherwise the
              morning pick) is graded for our performance stats. You can see the original
              morning pick and what it would have scored on the performance page.
            </p>
          </div>
        </div>
      </details>
    </div>
  )
}
