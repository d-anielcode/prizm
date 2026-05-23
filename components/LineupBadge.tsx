// LineupBadge — visual chip showing a player's confirmed lineup status for
// tonight's game. Populated from confirmed_lineups via lib/lineups.ts:loadLineupMap.
//
// Three render states:
//   role='starter'       → emerald "✓ STARTER" chip
//   role='out'           → red    "✗ OUT" chip (rarely shown — odds API
//                                  usually doesn't offer props for confirmed-out players)
//   null (no lineup data) → renders nothing (graceful)
//
// Status nuance (confirmed > expected > projected) shown via the chip's
// title tooltip so it doesn't crowd the UI.

import type { LineupBadgeInfo } from '@/lib/lineups'

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  expected:  'Expected',
  projected: 'Projected',
  unknown:   '',
}

export function LineupBadge({ info }: { info: LineupBadgeInfo | null }) {
  if (!info) return null

  if (info.role === 'out') {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold bg-red-500/10 text-red-300 border-red-500/25"
        title={`${STATUS_LABEL[info.status] || ''} OUT — model penalizes this prop heavily (lineupAdj = -25)`}
      >
        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
        OUT
      </span>
    )
  }

  // role === 'starter'
  const isConfirmed = info.status === 'confirmed'
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold ${
        isConfirmed
          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
          : 'bg-emerald-500/5 text-emerald-400/70 border-emerald-500/15'
      }`}
      title={`${STATUS_LABEL[info.status] || 'Listed'} starter — model adds +2 pts to all this player's props (lineupAdj = +2)`}
    >
      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      {isConfirmed ? 'STARTER' : 'EXP'}
    </span>
  )
}
