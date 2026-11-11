# Prizm 2.0 Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the gold-accent visual system with a modern electric-purple brand, green/amber/blue/red confidence tiers, Inter + JetBrains Mono typography, and solid elevated cards.

**Architecture:** Rewrite `globals.css` color tokens, swap fonts in `layout.tsx`, restyle the layout shell (header, nav), update ConfidenceBadge colors, and update the Logo. All changes are CSS/component-level — no data or API changes.

**Tech Stack:** Next.js 16, Tailwind CSS v4, React 19, Google Fonts (Inter, JetBrains Mono)

---

### Task 1: Rewrite globals.css — New Color Tokens + Typography + Background

**Files:**
- Modify: `app/globals.css`

Replace the entire globals.css with the new Prizm 2.0 design system tokens.

- [ ] **Step 1: Replace the full contents of `app/globals.css`**

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

/* ── Prizm 2.0 Dark Theme ─────────────────────────────────────────────────── */
:root {
  /* Prizm 2.0 — dark only */
  --background: #0F1117;
  --foreground: #F1F2F6;
  --card: #1A1D27;
  --card-foreground: #F1F2F6;
  --popover: #1A1D27;
  --popover-foreground: #F1F2F6;
  --primary: #6C5CE7;
  --primary-foreground: #FFFFFF;
  --secondary: #242835;
  --secondary-foreground: #F1F2F6;
  --muted: #242835;
  --muted-foreground: #8B8FA3;
  --accent: #242835;
  --accent-foreground: #F1F2F6;
  --destructive: #FF4757;
  --border: #2D3142;
  --input: #2D3142;
  --ring: #6C5CE7;
  --chart-1: #6C5CE7;
  --chart-2: #00D68F;
  --chart-3: #FFB800;
  --chart-4: #3B82F6;
  --chart-5: #FF4757;
  --radius: 0.75rem;

  /* Confidence tier colors */
  --color-lock: #00D68F;
  --color-play: #FFB800;
  --color-lean: #3B82F6;
  --color-fade: #FF4757;

  /* Surface layers */
  --bg-surface: #1A1D27;
  --bg-surface-2: #242835;
  --bg-surface-3: #2D3142;

  /* Text */
  --text-primary: #F1F2F6;
  --text-secondary: #8B8FA3;
  --text-tertiary: #5A5E72;

  /* Borders */
  --border-default: #2D3142;
  --border-subtle: #1F2233;

  /* Shadows */
  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.3);
  --shadow-elevated: 0 4px 16px rgba(0, 0, 0, 0.4);

  /* Sidebar (keep for shadcn compat) */
  --sidebar: #1A1D27;
  --sidebar-foreground: #F1F2F6;
  --sidebar-primary: #6C5CE7;
  --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #242835;
  --sidebar-accent-foreground: #F1F2F6;
  --sidebar-border: #2D3142;
  --sidebar-ring: #6C5CE7;
}

/* Also set .dark to the same values for shadcn dark variant compat */
.dark {
  --background: #0F1117;
  --foreground: #F1F2F6;
  --card: #1A1D27;
  --card-foreground: #F1F2F6;
  --popover: #1A1D27;
  --popover-foreground: #F1F2F6;
  --primary: #6C5CE7;
  --primary-foreground: #FFFFFF;
  --secondary: #242835;
  --secondary-foreground: #F1F2F6;
  --muted: #242835;
  --muted-foreground: #8B8FA3;
  --accent: #242835;
  --accent-foreground: #F1F2F6;
  --destructive: #FF4757;
  --border: #2D3142;
  --input: #2D3142;
  --ring: #6C5CE7;
  --chart-1: #6C5CE7;
  --chart-2: #00D68F;
  --chart-3: #FFB800;
  --chart-4: #3B82F6;
  --chart-5: #FF4757;
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
    background-attachment: fixed;
    /* Subtle purple glow at top of page */
    background-image:
      radial-gradient(ellipse 80% 50% at 50% -20%, rgba(108, 92, 231, 0.08) 0%, transparent 70%);
  }
  html {
    @apply font-sans;
  }
}

/* Dark select dropdowns */
select {
  color-scheme: dark;
}
select option {
  background-color: #1A1D27;
  color: #F1F2F6;
}
```

- [ ] **Step 2: Verify the app builds**

Run: `npx next build`
Expected: Build succeeds. Pages will look partially broken (gold references still in components) — that's expected, we fix those in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add app/globals.css
git commit -m "feat(design): Prizm 2.0 color tokens — purple brand, new tier colors, hex palette"
```

---

### Task 2: Update layout.tsx — New Fonts + Header Restyle

**Files:**
- Modify: `app/layout.tsx`

Swap Geist fonts for Inter + JetBrains Mono and restyle the header.

- [ ] **Step 1: Replace the full contents of `app/layout.tsx`**

```tsx
import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { NavTabs } from '@/components/NavTabs'
import { HeaderSearch } from '@/components/HeaderSearch'
import { MobileNav } from '@/components/MobileNav'
import { Logo } from '@/components/Logo'
import Link from 'next/link'

const inter = Inter({ variable: '--font-sans', subsets: ['latin'] })
const jetbrainsMono = JetBrains_Mono({ variable: '--font-mono', subsets: ['latin'] })

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
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} dark h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="sticky top-0 z-50 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/90 backdrop-blur-xl">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center gap-6">
            {/* Logo + wordmark */}
            <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
              <Logo size={26} />
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-bold tracking-tight text-foreground">Prizm</span>
                <span className="hidden sm:block text-[10px] text-[var(--text-tertiary)] font-medium tracking-widest uppercase">
                  AI Props
                </span>
              </div>
            </Link>

            {/* Nav tabs — center (desktop only) */}
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
```

Key changes:
- `Geist` / `Geist_Mono` replaced with `Inter` / `JetBrains_Mono`
- Font variables now `--font-sans` and `--font-mono` (matching globals.css @theme)
- Header: removed gold gradient top-line, uses `var(--bg-surface)/90` + `backdrop-blur-xl`
- Header border: `var(--border-subtle)` instead of `white/[0.06]`
- Wordmark: plain `text-foreground` instead of `gold-text` class
- Subtitle: `var(--text-tertiary)` instead of `white/25`
- Max width: `max-w-5xl` instead of `max-w-7xl`

- [ ] **Step 2: Commit**

```bash
git add app/layout.tsx
git commit -m "feat(design): swap fonts to Inter + JetBrains Mono, restyle header"
```

---

### Task 3: Restyle NavTabs + MobileNav

**Files:**
- Modify: `components/NavTabs.tsx`
- Modify: `components/MobileNav.tsx`

Replace gold accent colors with purple in both navigation components.

- [ ] **Step 1: Replace the full contents of `components/NavTabs.tsx`**

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { label: 'Home',        href: '/' },
  { label: 'Feed',        href: '/feed' },
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
```

- [ ] **Step 2: Replace the full contents of `components/MobileNav.tsx`**

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  {
    label: 'Home',
    href: '/',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
      </svg>
    ),
  },
  {
    label: 'Feed',
    href: '/feed',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
      </svg>
    ),
  },
  {
    label: 'Trends',
    href: '/trends',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
      </svg>
    ),
  },
  {
    label: 'Props',
    href: '/props',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    label: 'Stats',
    href: '/performance',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
]

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/90 backdrop-blur-xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center">
        {TABS.map(({ label, href, icon }) => {
          const isActive = href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={[
                'relative flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-colors duration-150',
                isActive ? 'text-primary' : 'text-[var(--text-tertiary)]',
              ].join(' ')}
            >
              {icon}
              <span className="text-[10px] font-semibold tracking-wide">{label}</span>
              {isActive && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full bg-primary" />
              )}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
```

Key changes:
- Active state: `text-primary` (purple) instead of `text-[#f0c060]` (gold)
- Inactive state: `var(--text-tertiary)` instead of `white/30`
- Background: `var(--bg-surface)/90` instead of `#07050f/90`
- Border: `var(--border-subtle)` instead of `white/[0.07]`
- Active indicator: solid `bg-primary` instead of gold gradient
- Mobile indicator moved to **top** of tab (common modern pattern)

- [ ] **Step 3: Commit**

```bash
git add components/NavTabs.tsx components/MobileNav.tsx
git commit -m "feat(design): restyle nav tabs + mobile nav with purple accents"
```

---

### Task 4: Update Logo + ConfidenceBadge

**Files:**
- Modify: `components/Logo.tsx`
- Modify: `components/ConfidenceBadge.tsx`

- [ ] **Step 1: Replace the full contents of `components/Logo.tsx`**

```tsx
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="prism-primary" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#A29BFE" />
          <stop offset="50%"  stopColor="#6C5CE7" />
          <stop offset="100%" stopColor="#5A4BD1" />
        </linearGradient>
        <linearGradient id="prism-face" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#A29BFE" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#6C5CE7" stopOpacity="0.5" />
        </linearGradient>
      </defs>
      {/* Left face */}
      <polygon points="16,3 4,27 16,22" fill="url(#prism-face)" opacity="0.6" />
      {/* Right bright face */}
      <polygon points="16,3 28,27 16,22" fill="url(#prism-primary)" />
      {/* Bottom bar */}
      <polygon points="4,27 28,27 16,22" fill="url(#prism-primary)" opacity="0.4" />
      {/* Outline */}
      <polygon
        points="16,3 28,27 4,27"
        fill="none"
        stroke="url(#prism-primary)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {/* Inner 3D line */}
      <line x1="16" y1="3" x2="16" y2="22" stroke="#A29BFE" strokeWidth="0.8" opacity="0.7" />
    </svg>
  )
}
```

- [ ] **Step 2: Replace the full contents of `components/ConfidenceBadge.tsx`**

```tsx
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
```

Key changes:
- Logo: gold gradients replaced with purple (`#6C5CE7` / `#A29BFE`)
- ConfidenceBadge: new tier colors (green LOCK, amber PLAY, blue LEAN, red FADE)
- Badge shape: `rounded-md` instead of `rounded-full` (more modern, less bubbly)
- Badge font: added `font-mono` for tabular numbers
- FADE is intentionally muted (`/70` text opacity, `/15` border)

- [ ] **Step 3: Commit**

```bash
git add components/Logo.tsx components/ConfidenceBadge.tsx
git commit -m "feat(design): purple logo + new tier colors (green/amber/blue/red)"
```

---

### Task 5: Clean Up References to Old Gold System + Visual Verify

**Files:**
- Modify: any files still referencing `gold-text`, `gold-border`, `card-glow`, `#f0c060`, `#e8a820`, `oklch(0.78`

- [ ] **Step 1: Search for remaining gold references across the codebase**

Run: `grep -r "gold-text\|gold-border\|card-glow\|f0c060\|e8a820\|c47c0a\|f5d070\|d4900e\|prism-gold" --include="*.tsx" --include="*.ts" --include="*.css" -l`

For each file found: replace gold color references with the appropriate new token:
- `gold-text` class usage → plain `text-foreground` or `text-primary`
- `#f0c060` / `#e8a820` → `var(--color-primary)` or the appropriate tier color
- `oklch(0.78 0.16 78)` → `#6C5CE7` (primary purple)
- Remove any remaining `.gold-text`, `.gold-border`, `.card-glow` class definitions

The exact replacements depend on context — each usage needs to be read and replaced with the semantically correct new token.

- [ ] **Step 2: Verify the app builds cleanly**

Run: `npx next build`
Expected: No build errors.

- [ ] **Step 3: Start the dev server and visually verify**

Run: `npm run dev`

Check:
- Homepage: header is dark surface with purple logo, no gold anywhere
- Mobile nav: purple active tab indicator at top
- Desktop nav: purple underline on active tab
- Props page: confidence badges show green/amber/blue/red
- Feed page: no gold text or borders
- Performance page: tier colors are new system

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(design): remove all gold references, complete Prizm 2.0 foundation"
```

- [ ] **Step 5: Commit spec + plan docs**

```bash
git add docs/superpowers/specs/2026-04-12-design-system-foundation-design.md docs/superpowers/plans/2026-04-12-design-system-foundation.md
git commit -m "docs: add Prizm 2.0 design system spec and plan"
```
