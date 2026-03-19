'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { label: 'Home',        href: '/' },
  { label: 'Trends',      href: '/trends' },
  { label: 'Props',       href: '/props' },
  { label: 'Performance', href: '/performance' },
]

export function NavTabs() {
  const pathname = usePathname()

  return (
    <nav className="hidden sm:flex items-center">
      {TABS.map(({ label, href }) => {
        const isActive = href === '/' ? pathname === '/' : pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={[
              'relative px-5 py-1 text-sm font-semibold transition-colors duration-200',
              isActive ? 'text-white' : 'text-white/35 hover:text-white/65',
            ].join(' ')}
          >
            {label}
            {isActive && (
              <span className="absolute bottom-[-1px] left-3 right-3 h-[2px] rounded-full bg-gradient-to-r from-[#e8a820]/60 via-[#f0c060] to-[#e8a820]/60" />
            )}
          </Link>
        )
      })}
    </nav>
  )
}
