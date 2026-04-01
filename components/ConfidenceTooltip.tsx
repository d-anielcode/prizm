'use client'

import { useState, useRef, useEffect } from 'react'
import type { ConfidenceLabel } from '@/types'

const TIPS: Record<ConfidenceLabel, string> = {
  LOCK: 'Highest confidence pick. The model sees strong agreement across multiple factors \u2014 66%+ historical hit rate.',
  PLAY: 'Strong conviction pick. Most factors align, but not as dominant as a LOCK \u2014 55%+ hit rate.',
  LEAN: 'Slight statistical edge. Around 50% hit rate \u2014 useful for research, not for betting alone.',
  FADE: 'Model says avoid. Factors disagree or point against this prop \u2014 below 50% expected hit rate.',
}

const COLORS: Record<ConfidenceLabel, string> = {
  LOCK: 'border-violet-500/30',
  PLAY: 'border-emerald-500/30',
  LEAN: 'border-[#e8a820]/30',
  FADE: 'border-red-500/30',
}

export function ConfidenceTooltip({ label }: { label: ConfidenceLabel }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(!open) }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="w-4 h-4 rounded-full border border-white/15 bg-white/5 flex items-center justify-center text-[9px] text-white/30 hover:text-white/50 hover:border-white/25 transition-colors cursor-help"
        aria-label={`What does ${label} mean?`}
      >
        ?
      </button>
      {open && (
        <div className={`absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-lg border ${COLORS[label]} bg-[#0f0f17] px-3 py-2.5 shadow-xl pointer-events-none`}>
          <p className="text-[11px] text-white/60 leading-relaxed">{TIPS[label]}</p>
          <div className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-[#0f0f17] border-r border-b border-white/10 -mt-1" />
        </div>
      )}
    </div>
  )
}
