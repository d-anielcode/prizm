'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { modeOf, counterpartPath, type Mode } from '@/lib/mode'

// "Prediction" only on wide screens: the desktop header has no room for it next to 7 tabs.
const LABEL: Record<Mode, React.ReactNode> = {
  sportsbook: 'Sportsbook',
  markets: <><span className="hidden xl:inline">Prediction </span>Markets</>,
}

export function ModeToggle() {
  const pathname = usePathname()
  const mode = modeOf(pathname)
  const other = counterpartPath(pathname)
  return (
    <div className="flex items-center whitespace-nowrap rounded-full border border-white/10 p-0.5 text-xs font-semibold">
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
