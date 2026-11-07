'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { modeOf, counterpartPath, type Mode } from '@/lib/mode'

const LABEL: Record<Mode, string> = { sportsbook: 'Sportsbook', markets: 'Prediction Markets' }

export function ModeToggle() {
  const pathname = usePathname()
  const mode = modeOf(pathname)
  const other = counterpartPath(pathname)
  return (
    <div className="flex items-center rounded-full border border-white/10 p-0.5 text-xs font-semibold">
      {(['sportsbook', 'markets'] as const).map((m) =>
        m === mode ? (
          <span key={m} aria-current="page" className="rounded-full bg-primary/20 px-3 py-1 text-[var(--text-primary)]">
            {LABEL[m]}
          </span>
        ) : (
          <Link key={m} href={other} className="rounded-full px-3 py-1 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">
            {LABEL[m]}
          </Link>
        ),
      )}
    </div>
  )
}
