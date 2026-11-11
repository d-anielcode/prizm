// PlayerBiasChip — small inline badge showing book mispricing on a player|stat.
//
// Renders only when the underlying player_line_bias row clears BIAS_MIN_SAMPLES
// (6) and BIAS_DISPLAY_THRESHOLD (5pp). When the bias direction matches the
// user's pick (alignsWithPick), the chip is emerald — "the book's mispricing
// supports your side." When it disagrees, the chip is amber — "the historical
// trend is against your pick; treat with caution."

import type { BiasSignal } from '@/lib/player-bias'

export function PlayerBiasChip({ signal }: { signal: BiasSignal | null }) {
  if (!signal) return null
  const pct  = Math.round(signal.magnitude * 100)
  const sign = signal.edge === 'over' ? '+' : '-'
  const text = `Books ${signal.edge === 'over' ? 'underprice' : 'overprice'} ${sign}${pct}%`
  const cls  = signal.alignsWithPick
    ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
    : 'bg-amber-500/10 text-amber-300 border-amber-500/25'
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold ${cls}`}
      title={`Historical bias from ${signal.sampleCount} graded props. ${signal.alignsWithPick ? 'Supports' : 'Contradicts'} this pick direction.`}
    >
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
      <span>{text}</span>
    </span>
  )
}
