import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'NBA IQ — AI-Powered Prop Analysis',
  description: 'Confidence-scored NBA player props powered by real game data.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-50 border-b border-white/10 bg-background/80 backdrop-blur-sm">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-white">NBA IQ</span>
              <span className="hidden sm:block text-xs text-white/30 font-medium mt-0.5">AI Prop Analysis</span>
            </div>
            <span className="text-xs text-white/30">Today&apos;s Games</span>
          </div>
        </header>

        <main className="flex-1">
          {children}
        </main>
      </body>
    </html>
  )
}
