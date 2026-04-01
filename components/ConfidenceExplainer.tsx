'use client'

import { useState } from 'react'

const TIERS = [
  {
    label: 'LOCK',
    color: 'text-violet-400',
    dot: 'bg-violet-400',
    description: 'Highest confidence. Multiple factors strongly agree \u2014 66%+ historical hit rate.',
  },
  {
    label: 'PLAY',
    color: 'text-emerald-400',
    dot: 'bg-emerald-400',
    description: 'Strong pick. Most factors align but not as dominant \u2014 55%+ hit rate.',
  },
  {
    label: 'LEAN',
    color: 'text-[#f0c060]',
    dot: 'bg-[#f0c060]',
    description: 'Slight edge. Around 50% hit rate \u2014 useful for research, not for betting alone.',
  },
  {
    label: 'FADE',
    color: 'text-red-400',
    dot: 'bg-red-400',
    description: 'Avoid. Factors disagree or point against this prop \u2014 below 50% expected hit rate.',
  },
] as const

export function ConfidenceExplainer() {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-xs text-white/50 font-semibold">How Prizm Works</span>
        </div>
        <svg
          className={`w-4 h-4 text-white/30 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-5 pb-5 flex flex-col gap-4 border-t border-white/[0.05]">
          <div className="pt-4">
            <p className="text-[11px] text-white/35 leading-relaxed">
              Prizm scores every NBA player prop using AI that analyzes recent performance,
              matchup data, defense rankings, line movement, and 10+ other factors. Each prop
              gets a 0-100 confidence score and a tier label:
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {TIERS.map((tier) => (
              <div
                key={tier.label}
                className="flex items-start gap-3 rounded-xl px-3.5 py-3 bg-white/[0.02] border border-white/[0.05]"
              >
                <div className={`w-2 h-2 rounded-full shrink-0 mt-1 ${tier.dot}`} />
                <div>
                  <p className={`text-xs font-bold ${tier.color}`}>{tier.label}</p>
                  <p className="text-[11px] text-white/40 leading-relaxed mt-0.5">
                    {tier.description}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl px-3.5 py-3 bg-white/[0.02] border border-white/[0.05]">
            <p className="text-[11px] text-white/40 leading-relaxed">
              <span className="text-white/60 font-semibold">Tip:</span>{' '}
              Focus on LOCKs and PLAYs for your bets. Check the{' '}
              <span className="text-[#f0c060] font-semibold">Feed</span>{' '}
              tab for daily curated parlays that combine our highest-confidence picks
              into ready-to-bet slips.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
