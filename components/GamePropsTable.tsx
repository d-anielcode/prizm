'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { ConfidenceBadge } from './ConfidenceBadge'
import AltLinesPanel from './AltLinesPanel'
import { PropReasonChips } from './PropReasonChips'
import type { AltLine, OpponentCtx, PropWithAlts, StatType } from '@/types'
import type { PropResult } from '@/app/game/[id]/page'

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST',
  steals: 'STL', blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

function impliedProb(odds: number): number {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100)
  return 100 / (odds + 100)
}
function fmtOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`
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
      {probPct != null && <span className={`font-bold ${probColor}`}>{probPct}%</span>}
    </div>
  )
}

function OpponentChip({ ctx, direction }: { ctx: OpponentCtx; direction: 'over' | 'under' }) {
  const { oppAbbr, rank, overHitRate } = ctx

  // Color logic: for OVER, high rank (soft D) = green; low rank (tough D) = red. Flip for UNDER.
  let rankColor = 'text-white/35'
  if (rank != null) {
    const favorable = direction === 'over' ? rank >= 22 : rank <= 9
    const unfavorable = direction === 'over' ? rank <= 9 : rank >= 22
    if (favorable)   rankColor = 'text-emerald-400'
    else if (unfavorable) rankColor = 'text-red-400'
    else rankColor = 'text-[#f0c060]'
  }

  const hitPct = overHitRate != null ? Math.round(overHitRate * 100) : null
  const hitColor = hitPct == null ? 'text-white/30'
    : direction === 'over'
      ? hitPct >= 58 ? 'text-emerald-400' : hitPct <= 42 ? 'text-red-400' : 'text-[#f0c060]'
      : hitPct <= 42 ? 'text-emerald-400' : hitPct >= 58 ? 'text-red-400' : 'text-[#f0c060]'

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[10px] text-white/25">vs</span>
      <span className="text-[10px] font-bold text-white/50">{oppAbbr}</span>
      {rank != null && (
        <span className={`text-[10px] font-semibold ${rankColor}`}>#{rank}</span>
      )}
      {hitPct != null && (
        <span className={`text-[10px] ${hitColor}`}>{hitPct}% OVR</span>
      )}
    </div>
  )
}

export default function GamePropsTable({
  props,
  oppCtx,
  propResults,
}: {
  props:        PropWithAlts[]
  oppCtx?:      Map<string, OpponentCtx>
  propResults?: Map<string, PropResult>
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <>
      {/* Mobile cards */}
      <div className="sm:hidden rounded-xl border border-white/10 overflow-hidden divide-y divide-white/[0.06]">
        {props.map((prop, i) => (
          <div key={prop.id ?? i} className="px-4 py-3 bg-white/[0.02]">
            <div className="flex items-center justify-between gap-2 mb-1">
              <Link href={`/player/${encodeURIComponent(prop.player_name)}`}
                className="font-medium text-white text-sm leading-tight hover:text-[#f0c060] transition-colors">
                {prop.player_name}
              </Link>
              <div className="flex items-center gap-2 shrink-0">
                {prop.id && propResults?.get(prop.id) != null && (() => {
                  const r = propResults!.get(prop.id!)!
                  return r.hit === null ? null : (
                    <span className={`text-xs font-black ${r.hit ? 'text-emerald-400' : 'text-red-400'}`}>
                      {r.hit ? '✓' : '✗'}{r.actual !== null ? ` ${r.actual}` : ''}
                    </span>
                  )
                })()}
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
              {prop.id && oppCtx?.get(prop.id) && (
                <OpponentChip ctx={oppCtx.get(prop.id)!} direction={prop.direction} />
              )}
            </div>
            <PropReasonChips reason={prop.confidence_reason} />
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
              {propResults && propResults.size > 0 && <th className="px-4 py-3 text-left">Result</th>}
              <th className="px-4 py-3 text-left">Reason</th>
            </tr>
          </thead>
          <tbody>
            {props.map((prop, i) => {
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
                      <Link href={`/player/${encodeURIComponent(prop.player_name)}`}
                        className="hover:text-blue-400 transition-colors"
                        onClick={(e) => e.stopPropagation()}>
                        {prop.player_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-white/60">{STAT_LABELS[prop.stat_type] ?? prop.stat_type}</div>
                      {prop.id && oppCtx?.get(prop.id) && (
                        <OpponentChip ctx={oppCtx.get(prop.id)!} direction={prop.direction} />
                      )}
                    </td>
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
                      {prop.confidence_label && prop.confidence_score != null ? (
                        <ConfidenceBadge label={prop.confidence_label} score={prop.confidence_score} />
                      ) : (
                        <span className="text-white/30">—</span>
                      )}
                    </td>
                    {propResults && propResults.size > 0 && (() => {
                      const r = prop.id ? propResults.get(prop.id) : null
                      if (!r) return <td className="px-4 py-3 text-white/20 text-xs">—</td>
                      if (r.hit === null) return <td className="px-4 py-3 text-white/20 text-xs">DNP</td>
                      return (
                        <td className={`px-4 py-3 text-sm font-black ${r.hit ? 'text-emerald-400' : 'text-red-400'}`}>
                          {r.hit ? '✓' : '✗'} {r.actual !== null ? r.actual : ''}
                        </td>
                      )
                    })()}
                    <td className="px-4 py-3 max-w-xs">
                      <PropReasonChips reason={prop.confidence_reason} />
                    </td>
                  </tr>

                  {hasAlts && (
                    <tr>
                      <td colSpan={propResults && propResults.size > 0 ? 7 : 6} className="p-0">
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
      </div>
    </>
  )
}
