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
  const [dirFilter, setDirFilter] = useState<'over' | 'under' | 'all'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    return props.filter((p) => {
      if (search && !p.player_name.toLowerCase().includes(search.toLowerCase())) return false
      if (statFilter !== 'all' && p.stat_type !== statFilter) return false
      if (labelFilter !== 'all' && p.confidence_label !== labelFilter) return false
      if (dirFilter !== 'all' && p.direction !== dirFilter) return false
      return true
    })
  }, [props, search, statFilter, labelFilter, dirFilter])

  return (
    <div className="flex flex-col gap-4">
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

        <select value={statFilter} onChange={(e) => setStatFilter(e.target.value as StatType | 'all')}
          className="px-3 py-1.5 rounded-lg bg-[#0e0b18] border border-white/[0.08] text-sm text-white/80 focus:outline-none focus:border-[#e8a820]/40 transition-colors cursor-pointer">
          <option value="all">All Stats</option>
          {(Object.keys(STAT_LABELS) as StatType[]).map((s) => (
            <option key={s} value={s}>{STAT_LABELS[s]}</option>
          ))}
        </select>

        <select value={dirFilter} onChange={(e) => setDirFilter(e.target.value as 'over' | 'under' | 'all')}
          className="px-3 py-1.5 rounded-lg bg-[#0e0b18] border border-white/[0.08] text-sm text-white/80 focus:outline-none focus:border-[#e8a820]/40 transition-colors cursor-pointer">
          <option value="all">Over + Under</option>
          <option value="over">Over only</option>
          <option value="under">Under only</option>
        </select>

        <select value={labelFilter} onChange={(e) => setLabelFilter(e.target.value as ConfidenceLabel | 'all')}
          className="px-3 py-1.5 rounded-lg bg-[#0e0b18] border border-white/[0.08] text-sm text-white/80 focus:outline-none focus:border-[#e8a820]/40 transition-colors cursor-pointer">
          <option value="all">All Confidence</option>
          <option value="LOCK">Lock only</option>
          <option value="PLAY">Play only</option>
          <option value="LEAN">Lean only</option>
          <option value="FADE">Fade only</option>
        </select>

        <span className="ml-auto self-center text-sm text-white/40">{filtered.length} props</span>
      </div>

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
              {prop.confidence_label && prop.confidence_score != null ? (
                <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
              ) : (
                <span className="text-white/30 text-xs">—</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-white/50">
              <span className="font-semibold text-white/70">{STAT_LABELS[prop.stat_type] ?? prop.stat_type}</span>
              <span className="font-mono text-white">{prop.line}</span>
              <span className={prop.direction === 'over' ? 'text-blue-400 font-semibold' : 'text-orange-400 font-semibold'}>
                {prop.direction.toUpperCase()}
              </span>
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
                        <span className="font-mono text-white">{prop.line}</span>
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
                      <span className={prop.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}>
                        {prop.direction.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {prop.confidence_label && prop.confidence_score != null ? (
                        <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                      ) : (
                        <span className="text-white/30">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-white/40 text-xs max-w-xs truncate">
                      {prop.confidence_reason ?? '—'}
                    </td>
                  </tr>

                  {/* Expansion row for alt lines */}
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
    </div>
  )
}
