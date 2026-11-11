'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { modeOf, tabHref } from '@/lib/mode'

const TABS = [
  { label: 'Home',        href: '/' },
  { label: 'Feed',        href: '/feed' },
  { label: 'Edge',        href: '/edge' },
  { label: 'Trends',      href: '/trends' },
  { label: 'Props',       href: '/props' },
  { label: 'Performance', href: '/performance' },
  { label: 'Status',      href: '/status' },
]

export function NavTabs() {
  const pathname = usePathname()
  const mode = modeOf(pathname)

  return (
    <nav className="hidden sm:flex items-center">
      {TABS.map(({ label, href: base }) => {
        // Status is shared by both modes (one pipeline), so it keeps its own path.
        const href = base === '/status' ? base : tabHref(base, mode)
        const isActive = href === '/' || href === '/markets' ? pathname === href : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={[
              'relative px-5 py-1 text-sm font-semibold transition-colors duration-150',
              isActive
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
            ].join(' ')}
          >
            {label}
            {isActive && (
              <span className="absolute bottom-[-1px] left-3 right-3 h-[2px] rounded-full bg-primary" />
            )}
          </Link>
        )
      })}
    </nav>
  )
}
