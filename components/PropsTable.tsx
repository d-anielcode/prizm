'use client'

import React, { useState, useMemo } from 'react'
import Link from 'next/link'
import { ConfidenceBadge } from './ConfidenceBadge'
import AltLinesPanel from './AltLinesPanel'
import type { AltLine, PropWithAlts, StatType, ConfidenceLabel } from '@/types'

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
  three_pointers: '3PM',
  pra: 'PRA',
}

type Section = 'main' | 'alts' | 'unders' | 'top'

function TrendArrow({ score, prev }: { score: number | undefined | null; prev: number | undefined | null }) {
  if (score == null || prev == null) return null
  const delta = score - prev
  if (delta >= 2)  return <span className="text-emerald-400 text-xs font-bold leading-none" title={`+${delta.toFixed(0)} vs yesterday`}>↑</span>
  if (delta <= -2) return <span className="text-red-400 text-xs font-bold leading-none" title={`${delta.toFixed(0)} vs yesterday`}>↓</span>
  return null
}

function SharpMoneyBadge({ opening, current, direction }: { opening: number | null | undefined; current: number; direction: 'over' | 'under' }) {
  if (opening == null) return null
  const delta = current - opening
  if (Math.abs(delta) < 0.5) return null
  const confirming = direction === 'over' ? delta > 0 : delta < 0
  return (
    <span
      className={`text-[9px] font-black px-1 py-0.5 rounded ${confirming ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/15 text-red-400'}`}
      title={confirming ? 'Sharp money confirming this pick (line moved with direction)' : 'Sharp money against this pick (line moved opposite direction)'}
    >
      {confirming ? 'STEAM' : 'COUNTER'}
    </span>
  )
}

function LineMovement({ opening, current }: { opening: number | null | undefined; current: number }) {
  if (opening == null || opening === current) return null
  const delta = current - opening
  const moved = Math.abs(delta)
  if (moved < 0.5) return null
  const up = delta > 0
  return (
    <span
      className={`text-[9px] font-bold ml-1 ${up ? 'text-orange-400' : 'text-emerald-400'}`}
      title={`Line moved from ${opening} → ${current}`}
    >
      {up ? '↑' : '↓'}{moved % 1 === 0 ? moved.toFixed(0) : moved.toFixed(1)}
    </span>
  )
}

function impliedProb(odds: number): number {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100)
  return 100 / (odds + 100)
}
function fmtOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`
}

function AltLineChip({ alt, mainLine, mainDir }: { alt: AltLine; mainLine: number; mainDir: 'over' | 'under' }) {
  const prob    = alt.odds != null ? impliedProb(alt.odds) : null
  const probPct = prob != null ? Math.round(prob * 100) : null
  const probColor = probPct == null ? 'text-white/30'
    : probPct >= 65 ? 'text-emerald-400'
    : probPct >= 50 ? 'text-[#f0c060]'
    : 'text-red-400'
  const safer   = alt.direction === mainDir && (mainDir === 'over' ? alt.line < mainLine : alt.line > mainLine)
  const riskier = alt.direction === mainDir && (mainDir === 'over' ? alt.line > mainLine : alt.line < mainLine)
  const confColor = alt.confidence_label === 'LOCK' ? 'text-violet-400'
    : alt.confidence_label === 'PLAY' ? 'text-emerald-400'
    : alt.confidence_label === 'LEAN' ? 'text-[#f0c060]'
    : alt.confidence_label === 'FADE' ? 'text-red-400'
    : 'text-white/30'

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.07] text-xs">
      <span className="font-mono text-white/80 font-medium">{alt.line}</span>
      <span className={`font-semibold text-[10px] ${alt.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}`}>
        {alt.direction.toUpperCase()}
      </span>
      {safer   && <span className="text-[9px] text-emerald-400/60">safer</span>}
      {riskier && <span className="text-[9px] text-red-400/60">riskier</span>}
      {alt.confidence_score != null && (
        <span className={`text-[10px] font-semibold ${confColor}`}>
          {Math.round(alt.confidence_score)}
          {alt.confidence_label && <span className="font-normal text-white/30 ml-0.5">{alt.confidence_label[0]}</span>}
        </span>
      )}
      {alt.odds != null && (
        <span className={`font-mono ${alt.odds > 0 ? 'text-emerald-400/80' : 'text-white/45'}`}>
          {fmtOdds(alt.odds)}
        </span>
      )}
      {probPct != null && (
        <span className={`font-bold ${probColor}`}>{probPct}%</span>
      )}
    </div>
  )
}

// Card shown in the Alt Lines section — displays best alt line for a prop
function AltCard({ prop, alt }: { prop: PropWithAlts; alt: AltLine }) {
  const shift = alt.line - prop.line
  const isEasier = prop.direction === 'over' ? shift < 0 : shift > 0
  const shiftStr = `${shift > 0 ? '+' : ''}${shift % 1 === 0 ? shift.toFixed(0) : shift.toFixed(1)}`

  return (
    <div className="px-4 py-3 bg-white/[0.02]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <Link
          href={`/player/${encodeURIComponent(prop.player_name)}`}
          className="font-medium text-white text-sm leading-tight hover:text-[#f0c060] transition-colors"
        >
          {prop.player_name}
          {prop.team && <span className="text-white/25 text-xs font-normal ml-1.5">{prop.team}</span>}
        </Link>
        <div className="flex items-center gap-1.5">
          {alt.confidence_label && alt.confidence_score != null && (
            <ConfidenceBadge label={alt.confidence_label} score={alt.confidence_score} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-white/50 flex-wrap">
        <span className="font-semibold text-white/70">{STAT_LABELS[prop.stat_type] ?? prop.stat_type}</span>
        {/* main line → alt line */}
        <span className="font-mono text-white/35">{prop.line}</span>
        <span className="text-white/20">→</span>
        <span className="font-mono text-white font-semibold">{alt.line}</span>
        <span className={`font-semibold ${prop.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}`}>
          {prop.direction.toUpperCase()}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
          isEasier ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          {isEasier ? 'easier' : 'harder'} ({shiftStr})
        </span>
        {alt.odds != null && (
          <span className={`font-mono text-[11px] ml-auto ${alt.odds > 0 ? 'text-emerald-400/80' : 'text-white/40'}`}>
            {fmtOdds(alt.odds)}
          </span>
        )}
      </div>
    </div>
  )
}

export function PropsTable({
  props,
  initialSearch = '',
}: {
  props: PropWithAlts[]
  initialSearch?: string
}) {
  const [search, setSearch] = useState(initialSearch)
  const [statFilter, setStatFilter] = useState<StatType | 'all'>('all')
  const [labelFilter, setLabelFilter] = useState<ConfidenceLabel | 'all'>('all')
  const [activeSection, setActiveSection] = useState<Section>('main')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Unfiltered counts for tab badges
  const sectionCounts = useMemo(() => ({
    main:   props.length,
    alts:   props.filter((p) => (p.altLines ?? []).some((a) => a.confidence_score != null)).length,
    unders: props.filter((p) => p.direction === 'under').length,
    top:    props.filter((p) => p.confidence_label === 'LOCK' || p.confidence_label === 'PLAY').length,
  }), [props])

  // Main / Unders / Top Picks filtered list
  const filtered = useMemo(() => {
    return props.filter((p) => {
      if (search && !p.player_name.toLowerCase().includes(search.toLowerCase())) return false
      if (statFilter !== 'all' && p.stat_type !== statFilter) return false
      if (labelFilter !== 'all' && p.confidence_label !== labelFilter) return false
      if (activeSection === 'unders' && p.direction !== 'under') return false
      if (activeSection === 'top' && p.confidence_label !== 'LOCK' && p.confidence_label !== 'PLAY') return false
      return true
    })
  }, [props, search, statFilter, labelFilter, activeSection])

  // Alt Lines section: best alt per prop (highest confidence_score)
  const altCards = useMemo(() => {
    return props
      .map((p) => {
        const scored = (p.altLines ?? []).filter((a) => a.confidence_score != null)
        if (scored.length === 0) return null
        const best = [...scored].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))[0]
        return { prop: p, alt: best }
      })
      .filter((x): x is { prop: PropWithAlts; alt: AltLine } => x !== null)
      .filter(({ prop }) => !search || prop.player_name.toLowerCase().includes(search.toLowerCase()))
      .filter(({ prop }) => statFilter === 'all' || prop.stat_type === statFilter)
      .sort((a, b) => (b.alt.confidence_score ?? 0) - (a.alt.confidence_score ?? 0))
  }, [props, search, statFilter])

  const SECTIONS: { key: Section; label: string }[] = [
    { key: 'main',   label: 'Main Lines'   },
    { key: 'alts',   label: 'Alt Lines'    },
    { key: 'unders', label: 'Unders'       },
    { key: 'top',    label: 'Top Picks'    },
  ]

  const displayCount = activeSection === 'alts' ? altCards.length : filtered.length
  const displayLabel = activeSection === 'alts' ? 'alt lines' : 'props'

  return (
    <div className="flex flex-col gap-4">
      {/* Section tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {SECTIONS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveSection(key)}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              activeSection === key
                ? 'bg-[#e8a820] text-black'
                : 'bg-white/5 border border-white/[0.08] text-white/50 hover:bg-white/10 hover:text-white/80'
            }`}
          >
            {label}
            <span className={`text-xs font-normal ${activeSection === key ? 'text-black/50' : 'text-white/25'}`}>
              {sectionCounts[key]}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative w-full sm:w-auto">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search player..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full sm:min-w-[280px] pl-9 pr-4 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30 transition-colors"
          />
        </div>

        <select
          value={statFilter}
          onChange={(e) => setStatFilter(e.target.value as StatType | 'all')}
          className="px-3 py-1.5 rounded-lg bg-[#0e0b18] border border-white/[0.08] text-sm text-white/80 focus:outline-none focus:border-[#e8a820]/40 transition-colors cursor-pointer"
        >
          <option value="all">All Stats</option>
          {(Object.keys(STAT_LABELS) as StatType[]).map((s) => (
            <option key={s} value={s}>{STAT_LABELS[s]}</option>
          ))}
        </select>

        {/* Confidence filter — hidden in Alt Lines and Top Picks sections */}
        {activeSection !== 'alts' && activeSection !== 'top' && (
          <select
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value as ConfidenceLabel | 'all')}
            className="px-3 py-1.5 rounded-lg bg-[#0e0b18] border border-white/[0.08] text-sm text-white/80 focus:outline-none focus:border-[#e8a820]/40 transition-colors cursor-pointer"
          >
            <option value="all">All Confidence</option>
            <option value="LOCK">Lock only</option>
            <option value="PLAY">Play only</option>
            <option value="LEAN">Lean only</option>
            <option value="FADE">Fade only</option>
          </select>
        )}

        <span className="ml-auto self-center text-sm text-white/40">{displayCount} {displayLabel}</span>
      </div>

      {/* ── Alt Lines Section ── */}
      {activeSection === 'alts' && (
        <div className="rounded-xl border border-white/10 overflow-hidden divide-y divide-white/[0.06]">
          {altCards.length === 0 ? (
            <div className="py-16 text-center text-white/30">
              {props.some((p) => (p.altLines ?? []).length > 0)
                ? 'Alt lines are being scored — check back in a few minutes.'
                : 'No alt lines available yet.'}
            </div>
          ) : (
            altCards.map(({ prop, alt }, i) => (
              <AltCard key={`${prop.id ?? i}-alt`} prop={prop} alt={alt} />
            ))
          )}
        </div>
      )}

      {/* ── Main / Unders / Top Picks Sections ── */}
      {activeSection !== 'alts' && (
        <>
          {/* Mobile card list */}
          <div className="sm:hidden rounded-xl border border-white/10 overflow-hidden divide-y divide-white/[0.06]">
            {filtered.length === 0 ? (
              <div className="py-16 text-center text-white/30">No props match your filters.</div>
            ) : filtered.map((prop, i) => (
              <div key={prop.id ?? i} className="px-4 py-3 bg-white/[0.02]">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Link href={`/player/${encodeURIComponent(prop.player_name)}`}
                    className="font-medium text-white text-sm leading-tight hover:text-[#f0c060] transition-colors">
                    {prop.player_name}
                  </Link>
                  <div className="flex items-center gap-1.5">
                    <TrendArrow score={prop.confidence_score} prev={prop.prev_confidence_score} />
                    {prop.confidence_label && prop.confidence_score != null ? (
                      <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                    ) : (
                      <span className="text-white/30 text-xs">—</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-white/50">
                  <span className="font-semibold text-white/70">{STAT_LABELS[prop.stat_type] ?? prop.stat_type}</span>
                  <span className="flex items-center font-mono text-white">
                    {prop.line}
                    <LineMovement opening={prop.opening_line} current={prop.line} />
                  </span>
                  <span className={prop.direction === 'over' ? 'text-blue-400 font-semibold' : 'text-orange-400 font-semibold'}>
                    {prop.direction.toUpperCase()}
                  </span>
                  <SharpMoneyBadge opening={prop.opening_line} current={prop.line} direction={prop.direction} />
                </div>
                {prop.confidence_reason && (
                  <p className="text-[11px] text-white/30 mt-1.5 line-clamp-2 leading-relaxed">{prop.confidence_reason}</p>
                )}
                {prop.altLines && prop.altLines.length > 0 && (
                  <AltLinesPanel mainLine={prop.line} altLines={prop.altLines} direction={prop.direction} />
                )}
              </div>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block overflow-x-auto rounded-xl border border-white/10">
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
              <tbody>
                {filtered.map((prop, i) => {
                  const rowKey = prop.id ?? String(i)
                  const isOpen = expandedId === rowKey
                  const hasAlts = (prop.altLines?.length ?? 0) > 0

                  return (
                    <React.Fragment key={rowKey}>
                      <tr
                        className={`border-t border-white/5 transition-colors ${hasAlts ? 'cursor-pointer hover:bg-white/5' : 'hover:bg-white/5'}`}
                        onClick={hasAlts ? () => setExpandedId(isOpen ? null : rowKey) : undefined}
                      >
                        <td className="px-4 py-3 font-medium text-white">
                          <Link
                            href={`/player/${encodeURIComponent(prop.player_name)}`}
                            className="hover:text-blue-400 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {prop.player_name}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-white/60">{STAT_LABELS[prop.stat_type] ?? prop.stat_type}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <span className="flex items-center font-mono text-white">
                              {prop.line}
                              <LineMovement opening={prop.opening_line} current={prop.line} />
                            </span>
                            {hasAlts && (
                              <svg
                                className={`w-3.5 h-3.5 text-white/30 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
                                fill="none" stroke="currentColor" viewBox="0 0 24 24"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                              </svg>
                            )}
                          </div>
                          {hasAlts && (
                            <div className="text-[10px] text-white/25 text-right mt-0.5">
                              {prop.altLines!.length} alt line{prop.altLines!.length !== 1 ? 's' : ''}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={prop.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}>
                              {prop.direction.toUpperCase()}
                            </span>
                            <SharpMoneyBadge opening={prop.opening_line} current={prop.line} direction={prop.direction} />
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <TrendArrow score={prop.confidence_score} prev={prop.prev_confidence_score} />
                            {prop.confidence_label && prop.confidence_score != null ? (
                              <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                            ) : (
                              <span className="text-white/30">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-white/40 text-xs max-w-xs truncate">
                          {prop.confidence_reason ?? '—'}
                        </td>
                      </tr>

                      {/* Expansion row for alt lines dropdown */}
                      {hasAlts && (
                        <tr className="border-t-0">
                          <td colSpan={6} className="p-0">
                            <div
                              className="overflow-hidden transition-all duration-300 ease-in-out"
                              style={{ maxHeight: isOpen ? `${prop.altLines!.length * 60 + 32}px` : '0px' }}
                            >
                              <div className="px-4 py-3 bg-white/[0.015] border-t border-white/[0.04] flex flex-wrap gap-2">
                                {prop.altLines!.map((alt, j) => (
                                  <AltLineChip key={j} alt={alt} mainLine={prop.line} mainDir={prop.direction} />
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="py-16 text-center text-white/30">No props match your filters.</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
