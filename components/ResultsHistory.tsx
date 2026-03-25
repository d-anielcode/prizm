'use client'

import React from 'react'

interface ResultRow {
  date: string
  confidence_label: string
  total: number
  hits: number
  hit_rate: number
}

interface Props {
  results: ResultRow[]
}

const TIER_COLORS = {
  LOCK: { bar: 'bg-violet-500',  text: 'text-violet-400',  badge: 'bg-violet-500/12 border-violet-500/30 text-violet-400'  },
  PLAY: { bar: 'bg-emerald-500', text: 'text-emerald-400', badge: 'bg-emerald-500/12 border-emerald-500/30 text-emerald-400' },
  LEAN: { bar: 'bg-[#e8a820]',  text: 'text-[#f0c060]',   badge: 'bg-[#e8a820]/12 border-[#e8a820]/30 text-[#f0c060]'     },
  FADE: { bar: 'bg-red-500',    text: 'text-red-400',      badge: 'bg-red-500/12 border-red-500/30 text-red-400'           },
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const today     = new Date(); today.setHours(0,0,0,0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const target    = new Date(dateStr + 'T00:00:00')

  if (target.getTime() === yesterday.getTime()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function HitBar({ rate, color }: { rate: number; color: string }) {
  return (
    <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.round(rate * 100)}%` }}
      />
    </div>
  )
}

export default function ResultsHistory({ results }: Props) {
  if (!results || results.length === 0) return null

  // Group by date, keep only LOCK/PLAY/LEAN/FADE (not ALL)
  const byDate = new Map<string, Record<string, ResultRow>>()
  for (const r of results) {
    if (r.confidence_label === 'ALL') continue
    if (!byDate.has(r.date)) byDate.set(r.date, {})
    byDate.get(r.date)![r.confidence_label] = r
  }

  // Get ALL rows for the summary line
  const allByDate = new Map<string, ResultRow>()
  for (const r of results) {
    if (r.confidence_label === 'ALL') allByDate.set(r.date, r)
  }

  // Sort dates newest first, take last 7 days
  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 7)

  if (sortedDates.length === 0) return null

  const mostRecentDate  = sortedDates[0]
  const mostRecentAll   = allByDate.get(mostRecentDate)
  const mostRecentTiers = byDate.get(mostRecentDate) ?? {}

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-black text-white tracking-tight">Model Performance</h2>
          <span className="text-[11px] text-white/35 bg-white/[0.04] border border-white/[0.08] rounded-full px-2.5 py-0.5">
            {sortedDates.length}-day history
          </span>
        </div>
        {mostRecentAll && (
          <div className="text-right">
            <p className="text-[11px] text-white/35 uppercase tracking-wider">
              {formatDate(mostRecentDate)} overall
            </p>
            <p className="text-lg font-black text-white">
              {mostRecentAll.hits}/{mostRecentAll.total}
              <span className="text-sm font-normal text-white/40 ml-1.5">
                {Math.round(mostRecentAll.hit_rate * 100)}%
              </span>
            </p>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
        <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />

        {/* Most recent day — expanded */}
        <div className="p-5 flex flex-col gap-3">
          <p className="text-[11px] text-white/35 uppercase tracking-widest">
            {formatDate(mostRecentDate)}
          </p>

          {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as const).map((label) => {
            const row = mostRecentTiers[label]
            if (!row) return null
            const c = TIER_COLORS[label]
            const pct = Math.round(row.hit_rate * 100)
            return (
              <div key={label} className="flex items-center gap-3">
                <span className={`text-[10px] font-black w-14 shrink-0 px-1.5 py-0.5 rounded border text-center ${c.badge}`}>
                  {label}
                </span>
                <HitBar rate={row.hit_rate} color={c.bar} />
                <span className={`text-sm font-black shrink-0 w-10 text-right ${c.text}`}>
                  {pct}%
                </span>
                <span className="text-xs text-white/25 shrink-0 w-14 text-right">
                  {row.hits}/{row.total}
                </span>
              </div>
            )
          })}
        </div>

        {/* 7-day history table — compact rows */}
        {sortedDates.length > 1 && (
          <>
            <div className="h-px bg-white/[0.06]" />
            <div className="px-5 py-4 flex flex-col gap-0">
              <p className="text-[11px] text-white/35 uppercase tracking-widest mb-3">7-Day History</p>
              <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_1fr] gap-x-2 sm:gap-x-4 gap-y-2 text-[11px]">
                {/* Header */}
                <div className="text-white/20 uppercase tracking-wider">Date</div>
                <div className="text-violet-400/60 uppercase tracking-wider text-right">LOCK</div>
                <div className="text-emerald-400/60 uppercase tracking-wider text-right">PLAY</div>
                <div className="text-[#f0c060]/60 uppercase tracking-wider text-right">LEAN</div>
                <div className="text-red-400/60 uppercase tracking-wider text-right">FADE</div>
                <div className="text-white/20 uppercase tracking-wider text-right">ALL</div>

                {sortedDates.map((date) => {
                  const tiers = byDate.get(date) ?? {}
                  const all   = allByDate.get(date)
                  return (
                    <React.Fragment key={date}>
                      <div className="text-white/40">{formatDate(date)}</div>
                      {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as const).map((label) => {
                        const row = tiers[label]
                        if (!row) return <div key={`${date}-${label}`} className="text-white/20 text-right">—</div>
                        const pct = Math.round(row.hit_rate * 100)
                        const c = TIER_COLORS[label]
                        return (
                          <div key={`${date}-${label}`} className={`font-bold text-right ${c.text}`}>
                            {pct}%
                            <span className="font-normal text-white/25 ml-1">
                              {row.hits}/{row.total}
                            </span>
                          </div>
                        )
                      })}
                      <div className="text-white/50 font-bold text-right">
                        {all ? `${Math.round(all.hit_rate * 100)}%` : '—'}
                      </div>
                    </React.Fragment>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
