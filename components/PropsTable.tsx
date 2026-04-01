'use client'

import React, { useState, useMemo } from 'react'
import Link from 'next/link'
import { ConfidenceBadge } from './ConfidenceBadge'
import AltLinesPanel from './AltLinesPanel'
import { PropReasonChips } from './PropReasonChips'
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

const STAT_ORDER: StatType[] = ['points', 'rebounds', 'assists', 'three_pointers', 'steals', 'blocks', 'pra']

const LABEL_COLORS: Record<ConfidenceLabel, { active: string; inactive: string }> = {
  LOCK: { active: 'bg-violet-500/20 text-violet-400 border-violet-500/30', inactive: '' },
  PLAY: { active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', inactive: '' },
  LEAN: { active: 'bg-[#e8a820]/20 text-[#f0c060] border-[#e8a820]/30', inactive: '' },
  FADE: { active: 'bg-red-500/20 text-red-400 border-red-500/30', inactive: '' },
}

// ── Shared small components ──────────────────────────────────────────────────

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

// ── Filter pill components ───────────────────────────────────────────────────

const PILL_BASE = 'px-3 py-1 rounded-full text-xs font-semibold border transition-colors cursor-pointer select-none'
const PILL_INACTIVE = 'bg-white/[0.03] text-white/40 border-white/[0.08] hover:border-white/15 hover:text-white/60'
const PILL_ACTIVE = 'bg-[#e8a820]/15 text-[#f0c060] border-[#e8a820]/30'

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`${PILL_BASE} ${active ? PILL_ACTIVE : PILL_INACTIVE}`}>
      {children}
    </button>
  )
}

function ConfidencePill({ label, active, onClick }: { label: ConfidenceLabel; active: boolean; onClick: () => void }) {
  const colors = LABEL_COLORS[label]
  return (
    <button
      onClick={onClick}
      className={`${PILL_BASE} ${active ? colors.active : PILL_INACTIVE}`}
    >
      {label}
    </button>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

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
  const [directionFilter, setDirectionFilter] = useState<'all' | 'over' | 'under'>('all')
  const [gameFilter, setGameFilter] = useState<string>('all')
  const [showAlts, setShowAlts] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Derive unique games from props
  const games = useMemo(() => {
    const map = new Map<string, { home: string; away: string }>()
    for (const p of props) {
      if (p.game_id && !map.has(p.game_id)) {
        map.set(p.game_id, {
          home: p.home_team ?? '???',
          away: p.away_team ?? '???',
        })
      }
    }
    return [...map.entries()].map(([id, teams]) => ({ id, label: `${teams.away} @ ${teams.home}` }))
  }, [props])

  // Filtered props
  const filtered = useMemo(() => {
    return props.filter((p) => {
      if (search && !p.player_name.toLowerCase().includes(search.toLowerCase())) return false
      if (statFilter !== 'all' && p.stat_type !== statFilter) return false
      if (labelFilter !== 'all' && p.confidence_label !== labelFilter) return false
      if (directionFilter !== 'all' && p.direction !== directionFilter) return false
      if (gameFilter !== 'all' && p.game_id !== gameFilter) return false
      return true
    })
  }, [props, search, statFilter, labelFilter, directionFilter, gameFilter])

  return (
    <div className="flex flex-col gap-4">

      {/* ── Search bar ── */}
      <div className="relative">
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
          className="w-full pl-9 pr-4 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30 transition-colors"
        />
      </div>

      {/* ── Filter rows ── */}
      <div className="flex flex-col gap-3">

        {/* Direction */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">Direction</span>
          <div className="flex flex-wrap gap-1.5">
            <Pill active={directionFilter === 'all'} onClick={() => setDirectionFilter('all')}>Over + Under</Pill>
            <Pill active={directionFilter === 'over'} onClick={() => setDirectionFilter('over')}>Over</Pill>
            <Pill active={directionFilter === 'under'} onClick={() => setDirectionFilter('under')}>Under</Pill>
          </div>
        </div>

        {/* Stat type */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">Stat Type</span>
          <div className="flex flex-wrap gap-1.5">
            <Pill active={statFilter === 'all'} onClick={() => setStatFilter('all')}>All</Pill>
            {STAT_ORDER.map((s) => (
              <Pill key={s} active={statFilter === s} onClick={() => setStatFilter(s)}>{STAT_LABELS[s]}</Pill>
            ))}
          </div>
        </div>

        {/* Confidence */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">Confidence</span>
          <div className="flex flex-wrap gap-1.5">
            <Pill active={labelFilter === 'all'} onClick={() => setLabelFilter('all')}>All</Pill>
            {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as ConfidenceLabel[]).map((l) => (
              <ConfidencePill key={l} label={l} active={labelFilter === l} onClick={() => setLabelFilter(l)} />
            ))}
          </div>
        </div>

        {/* Games */}
        {games.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">Game</span>
            <div className="flex flex-wrap gap-1.5">
              <Pill active={gameFilter === 'all'} onClick={() => setGameFilter('all')}>All Games</Pill>
              {games.map((g) => (
                <Pill key={g.id} active={gameFilter === g.id} onClick={() => setGameFilter(g.id)}>{g.label}</Pill>
              ))}
            </div>
          </div>
        )}

        {/* Alt lines toggle + count */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowAlts(!showAlts)}
            className="flex items-center gap-2 text-xs text-white/40 hover:text-white/60 transition-colors"
          >
            <div className={`w-8 h-4 rounded-full transition-colors relative ${showAlts ? 'bg-[#e8a820]/40' : 'bg-white/10'}`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${showAlts ? 'left-4 bg-[#e8a820]' : 'left-0.5 bg-white/40'}`} />
            </div>
            <span className="font-semibold">Alt Lines</span>
          </button>
          <span className="text-sm text-white/40">{filtered.length} props</span>
        </div>
      </div>

      {/* ── Props list ── */}

      {/* Mobile cards */}
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
            <PropReasonChips reason={prop.confidence_reason} />
            {showAlts && prop.altLines && prop.altLines.length > 0 && (
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
              const isOpen = expandedId === rowKey || showAlts
              const hasAlts = (prop.altLines?.length ?? 0) > 0

              return (
                <React.Fragment key={rowKey}>
                  <tr
                    className={`border-t border-white/5 transition-colors ${hasAlts ? 'cursor-pointer hover:bg-white/5' : 'hover:bg-white/5'}`}
                    onClick={hasAlts ? () => setExpandedId(expandedId === rowKey ? null : rowKey) : undefined}
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
                        {hasAlts && !showAlts && (
                          <svg
                            className={`w-3.5 h-3.5 text-white/30 transition-transform duration-300 ${expandedId === rowKey ? 'rotate-180' : ''}`}
                            fill="none" stroke="currentColor" viewBox="0 0 24 24"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                          </svg>
                        )}
                      </div>
                      {hasAlts && (
                        <div className="text-[10px] text-white/25 text-right mt-0.5">
                          {prop.altLines!.length} alt{prop.altLines!.length !== 1 ? 's' : ''}
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
                    <td className="px-4 py-3 max-w-xs">
                      <PropReasonChips reason={prop.confidence_reason} />
                    </td>
                  </tr>

                  {/* Alt lines expansion */}
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
