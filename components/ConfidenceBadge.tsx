import { cn } from '@/lib/utils'
import type { ConfidenceLabel } from '@/types'

const styles: Record<ConfidenceLabel, string> = {
  HIGH: 'bg-green-500/15 text-green-400 border-green-500/30',
  MEDIUM: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  LOW: 'bg-red-500/15 text-red-400 border-red-500/30',
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
        styles[label]
      )}
    >
      <span className="text-[10px] opacity-80">{score}</span>
      {label}
    </span>
  )
}
