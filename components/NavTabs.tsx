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
]

export function NavTabs() {
  const pathname = usePathname()
  const mode = modeOf(pathname)

  return (
    <nav className="hidden md:flex items-center">
      {TABS.map(({ label, href: base }) => {
        const href = tabHref(base, mode)
        const isActive = href === '/' || href === '/markets' ? pathname === href : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={[
              'relative px-2.5 lg:px-4 py-1 text-sm font-semibold transition-colors duration-150',
              isActive
                ? 'text-[var(--text-primary)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
            ].join(' ')}
          >
            {label}
            {isActive && (
              <span className="absolute bottom-[-1px] left-2 right-2 h-[2px] rounded-full bg-primary" />
            )}
          </Link>
        )
      })}
    </nav>
  )
}
