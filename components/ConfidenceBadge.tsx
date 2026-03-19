import { cn } from '@/lib/utils'
import type { ConfidenceLabel } from '@/types'

const styles: Record<ConfidenceLabel, string> = {
  HIGH:   'bg-emerald-500/12 text-emerald-400 border-emerald-500/25 shadow-[0_0_10px_rgba(16,185,129,0.15)]',
  MEDIUM: 'bg-[#e8a820]/10  text-[#f0c060]   border-[#e8a820]/25',
  LOW:    'bg-red-500/10    text-red-400      border-red-500/20',
}

export function ConfidenceBadge({
  label,
  score,
}: {
  label: ConfidenceLabel
  score: number
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs font-semibold tabular-nums',
        styles[label],
      )}
    >
      <span className="text-[10px] opacity-70">{score}</span>
      {label}
    </span>
  )
}
