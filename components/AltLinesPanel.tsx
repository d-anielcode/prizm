'use client'

import { useState } from 'react'
import type { AltLine } from '@/types'

function impliedProb(odds: number): number {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100)
  return 100 / (odds + 100)
}

function fmtOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`
}

interface Props {
  mainLine:  number
  altLines:  AltLine[]
  direction: 'over' | 'under'
}

export default function AltLinesPanel({ mainLine, altLines, direction }: Props) {
  const [open, setOpen] = useState(false)

  if (altLines.length === 0) return null

  // Sort: same-direction alts by line, then opposite-direction alts
  const sameDir = altLines
    .filter((a) => a.direction === direction)
    .sort((a, b) => a.line - b.line)
  const otherDir = altLines
    .filter((a) => a.direction !== direction)
    .sort((a, b) => a.line - b.line)
  const sorted = [...sameDir, ...otherDir]

  return (
    <div className="mt-1">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="flex items-center gap-1.5 text-[11px] text-white/35 hover:text-white/60 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
        {altLines.length} alt line{altLines.length !== 1 ? 's' : ''}
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-white/[0.07] bg-white/[0.03] overflow-hidden px-3 py-2 flex flex-col gap-1">
          {sorted.map((alt, i) => <AltRow key={i} alt={alt} mainLine={mainLine} mainDir={direction} />)}
        </div>
      )}
    </div>
  )
}

function AltRow({ alt, mainLine, mainDir }: { alt: AltLine; mainLine: number; mainDir: 'over' | 'under' }) {
  const prob    = alt.odds != null ? impliedProb(alt.odds) : null
  const probPct = prob != null ? Math.round(prob * 100) : null
  const probColor = probPct == null ? 'text-white/30'
    : probPct >= 65 ? 'text-emerald-400'
    : probPct >= 50 ? 'text-[#f0c060]'
    : 'text-red-400'

  // Safer = easier to hit than the main line
  const safer =
    alt.direction === mainDir
      ? (mainDir === 'over' ? alt.line < mainLine : alt.line > mainLine)
      : false
  const riskier =
    alt.direction === mainDir
      ? (mainDir === 'over' ? alt.line > mainLine : alt.line < mainLine)
      : false

  const confColor = alt.confidence_label === 'LOCK' ? 'text-violet-400'
    : alt.confidence_label === 'PLAY' ? 'text-emerald-400'
    : alt.confidence_label === 'LEAN' ? 'text-[#f0c060]'
    : alt.confidence_label === 'FADE' ? 'text-red-400'
    : 'text-white/30'

  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono text-white/70 w-8 text-right">{alt.line}</span>
        <span className={`font-semibold text-[10px] ${alt.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}`}>
          {alt.direction.toUpperCase()}
        </span>
        {safer  && <span className="text-[9px] text-emerald-400/60">safer</span>}
        {riskier && <span className="text-[9px] text-red-400/60">riskier</span>}
      </div>
      <div className="flex items-center gap-3">
        {alt.confidence_score != null && (
          <span className={`text-[10px] font-semibold ${confColor}`}>
            {Math.round(alt.confidence_score)}
            {alt.confidence_label && <span className="font-normal text-white/30 ml-0.5">{alt.confidence_label[0]}</span>}
          </span>
        )}
        {alt.odds != null && (
          <span className={`font-mono text-[11px] ${alt.odds > 0 ? 'text-emerald-400/80' : 'text-white/45'}`}>
            {fmtOdds(alt.odds)}
          </span>
        )}
        {probPct != null && (
          <span className={`font-bold text-[11px] w-10 text-right ${probColor}`}>
            {probPct}%
          </span>
        )}
      </div>
    </div>
  )
}
