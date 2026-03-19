import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { NavTabs } from '@/components/NavTabs'
import { HeaderSearch } from '@/components/HeaderSearch'
import { MobileNav } from '@/components/MobileNav'
import { Logo } from '@/components/Logo'
import Link from 'next/link'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Prizm — AI-Powered NBA Prop Analysis',
  description: 'See what others miss. AI-scored NBA player props powered by real game data.',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-background/80 backdrop-blur-md">
          {/* Subtle gold top line */}
          <div className="h-px bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-6">
            {/* Logo + wordmark */}
            <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
              <Logo size={26} />
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-bold tracking-tight gold-text">Prizm</span>
                <span className="hidden sm:block text-[10px] text-white/25 font-medium tracking-widest uppercase">
                  AI Props
                </span>
              </div>
            </Link>

            {/* Nav tabs — center (desktop only, spacer kept on mobile) */}
            <div className="flex-1 flex justify-center">
              <NavTabs />
            </div>

            {/* Search — right */}
            <div className="shrink-0">
              <HeaderSearch />
            </div>
          </div>
        </header>

        <main className="flex-1 pb-20 sm:pb-0">
          {children}
        </main>

        <MobileNav />
      </body>
    </html>
  )
}
