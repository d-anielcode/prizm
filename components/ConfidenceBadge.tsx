import { cn } from '@/lib/utils'
import type { ConfidenceLabel } from '@/types'
import { ConfidenceTooltip } from '@/components/ConfidenceTooltip'

const styles: Record<ConfidenceLabel, string> = {
  LOCK: 'bg-[#00D68F]/15 text-[#00D68F] border-[#00D68F]/25 shadow-[0_0_12px_rgba(0,214,143,0.2)]',
  PLAY: 'bg-[#FFB800]/15 text-[#FFB800] border-[#FFB800]/25',
  LEAN: 'bg-[#3B82F6]/10 text-[#3B82F6] border-[#3B82F6]/20',
  FADE: 'bg-[#FF4757]/10 text-[#FF4757]/70 border-[#FF4757]/15',
}

export function ConfidenceBadge({
  label,
  score,
  showTooltip = false,
}: {
  label: ConfidenceLabel
  score: number
  showTooltip?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md border text-xs font-semibold tabular-nums font-mono',
          styles[label],
        )}
      >
        <span className="text-[10px] opacity-70">{score}</span>
        {label}
      </span>
      {showTooltip && <ConfidenceTooltip label={label} />}
    </span>
  )
}
