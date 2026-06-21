# Prizm 2.0 Design System Foundation — Spec

**Date:** 2026-04-12
**Goal:** Replace the current visual system (gold accents, Geist font, ghostly card borders) with a modern, PrizePicks-inspired design system: electric purple brand, green/amber/blue/red tier colors, Inter + JetBrains Mono typography, solid elevated cards, and refined spacing.

## Scope

This spec covers the **design system foundation only** — the tokens, globals, layout shell (header, nav, footer), and shared component styling. Individual page reworks come in subsequent specs.

**Files modified:**
- `app/globals.css` — Full color/token rewrite
- `app/layout.tsx` — Header + layout shell restyling
- `components/NavTabs.tsx` — Desktop nav restyling
- `components/MobileNav.tsx` — Mobile bottom nav restyling
- `components/Logo.tsx` — Updated logo with new brand color
- `components/ConfidenceBadge.tsx` — New tier color system
- `components/ui/button.tsx` — Updated button variants

**Files NOT modified (future specs):**
- Page content components (PropsTable, TodaysPicks, ResultsHistory, etc.)
- Individual page layouts (page.tsx files)

## 1. Color System

All colors defined as CSS custom properties in `globals.css`. Dark mode only.

### Core Tokens

```css
:root {
  /* Background layers */
  --bg-primary: #0F1117;        /* Page background — deep navy-black */
  --bg-surface: #1A1D27;        /* Cards, elevated containers */
  --bg-surface-2: #242835;      /* Inputs, chips, nested elements */
  --bg-surface-3: #2D3142;      /* Hover states on surface-2 */

  /* Brand */
  --color-primary: #6C5CE7;     /* Electric purple — main brand accent */
  --color-primary-light: #A29BFE; /* Hover/focus, secondary highlights */
  --color-primary-dim: rgba(108, 92, 231, 0.15); /* Subtle tint backgrounds */

  /* Confidence tiers */
  --color-lock: #00D68F;        /* Green — LOCK tier, hits, positive */
  --color-play: #FFB800;        /* Amber — PLAY tier, caution */
  --color-lean: #3B82F6;        /* Blue — LEAN tier, informational */
  --color-fade: #FF4757;        /* Red — FADE tier, misses, destructive */

  /* Text */
  --text-primary: #F1F2F6;      /* Main text */
  --text-secondary: #8B8FA3;    /* Labels, supporting text */
  --text-tertiary: #5A5E72;     /* Disabled, placeholder */

  /* Borders & dividers */
  --border-default: #2D3142;    /* Card borders */
  --border-subtle: #1F2233;     /* Dividers within cards */

  /* Shadows */
  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.3);
  --shadow-elevated: 0 4px 16px rgba(0, 0, 0, 0.4);
  --shadow-glow-lock: 0 0 12px rgba(0, 214, 143, 0.2);
  --shadow-glow-primary: 0 0 12px rgba(108, 92, 231, 0.2);
}
```

### Tailwind Integration

Map these to Tailwind v4 `@theme` tokens so they work with utility classes:

```css
@theme inline {
  --color-background: var(--bg-primary);
  --color-foreground: var(--text-primary);
  --color-card: var(--bg-surface);
  --color-card-foreground: var(--text-primary);
  --color-primary: var(--color-primary);
  --color-primary-foreground: #FFFFFF;
  --color-secondary: var(--bg-surface-2);
  --color-secondary-foreground: var(--text-primary);
  --color-muted: var(--bg-surface-2);
  --color-muted-foreground: var(--text-secondary);
  --color-accent: var(--bg-surface-2);
  --color-accent-foreground: var(--text-primary);
  --color-destructive: var(--color-fade);
  --color-border: var(--border-default);
  --color-ring: var(--color-primary);
}
```

## 2. Typography

### Fonts

Replace Geist with **Inter** (body) + **JetBrains Mono** (numbers/data).

```tsx
// app/layout.tsx
import { Inter, JetBrains_Mono } from 'next/font/google'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })
```

### Type Scale

| Token | Size | Weight | Line Height | Use |
|-------|------|--------|-------------|-----|
| `text-xs` | 11px | 600 | 1.4 | Uppercase labels, badges |
| `text-sm` | 13px | 400 | 1.5 | Secondary text, captions |
| `text-base` | 15px | 400 | 1.6 | Body text |
| `text-lg` | 18px | 600 | 1.4 | Card headings, section labels |
| `text-xl` | 22px | 700 | 1.3 | Page sub-headings |
| `text-2xl` | 28px | 700 | 1.2 | Page headings |
| `text-3xl` | 36px | 800 | 1.1 | Hero numbers (confidence scores) |

Numbers/stats always use `font-mono` (JetBrains Mono) for tabular alignment.

## 3. Spacing & Layout

### Spacing Scale (4px base)

```
4px (1) — tight internal spacing
8px (2) — default gap between inline elements
12px (3) — padding inside compact components
16px (4) — standard card padding, section gaps
24px (6) — between cards, major element spacing
32px (8) — section-to-section spacing
48px (12) — page-level padding top/bottom
```

### Layout Shell

```
┌─────────────────────────────────────────┐
│ Header (h-14, sticky, bg-surface, blur) │
│  Logo          NavTabs         Search   │
├─────────────────────────────────────────┤
│                                         │
│  Main content (max-w-5xl mx-auto)       │
│  px-4 sm:px-6 py-6                      │
│                                         │
├─────────────────────────────────────────┤
│ MobileNav (h-16, sticky bottom)         │
│  Home  Feed  Trends  Props  Stats       │
└─────────────────────────────────────────┘
```

- Page max-width: `max-w-5xl` (1024px) centered — keeps content scannable
- Mobile padding: `px-4` (16px sides)
- Desktop padding: `px-6` (24px sides)
- Content bottom padding: `pb-20` on mobile (clear bottom nav), `sm:pb-0`

## 4. Component Tokens

### Cards

```css
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  padding: 16px;
}
```

No more ghostly outlined cards — solid surfaces with subtle elevation.

### Buttons

| Variant | Background | Text | Border |
|---------|-----------|------|--------|
| Primary | `--color-primary` | white | none |
| Secondary | `--bg-surface-2` | `--text-primary` | `--border-default` |
| Ghost | transparent | `--text-secondary` | none |
| Destructive | `--color-fade` | white | none |

All buttons: `border-radius: 8px`, `padding: 8px 16px`, `font-weight: 500`, `transition: 150ms`.

### Chips / Filter Toggles

```css
.chip {
  background: var(--bg-surface-2);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  transition: all 150ms ease-out;
}
.chip-active {
  background: var(--color-primary-dim);
  border-color: var(--color-primary);
  color: var(--color-primary-light);
}
```

### Confidence Badges

| Tier | Background | Text | Shadow |
|------|-----------|------|--------|
| LOCK | `rgba(0,214,143,0.15)` | `--color-lock` | `--shadow-glow-lock` |
| PLAY | `rgba(255,184,0,0.15)` | `--color-play` | none |
| LEAN | `rgba(59,130,246,0.10)` | `--color-lean` | none |
| FADE | `rgba(255,71,87,0.10)` | `--color-fade` | none |

LOCK gets a subtle green glow to make it stand out. FADE is visually muted (desaturated).

## 5. Navigation

### Header

- Height: 56px (`h-14`)
- Background: `var(--bg-surface)` with `backdrop-filter: blur(12px)` and 90% opacity
- Bottom border: `1px solid var(--border-subtle)`
- Logo: Prism icon recolored to primary purple
- No more gold gradient top-line

### Mobile Bottom Nav

- Height: 64px (`h-16`) + safe area
- Background: `var(--bg-surface)` with blur
- Top border: `1px solid var(--border-subtle)`
- Active tab: Purple icon + purple text + 2px top indicator
- Inactive tab: `--text-tertiary` icon + text
- 5 items: Home, Feed, Trends, Props, Stats (unchanged)

### Desktop Nav Tabs

- Horizontal tabs in header center
- Active: `--text-primary` + purple underline (2px)
- Inactive: `--text-secondary`, hover → `--text-primary`

## 6. Background

Replace the current gold/purple radial gradient with a cleaner look:

```css
body {
  background: var(--bg-primary);
  /* Subtle gradient glow at top only */
  background-image: radial-gradient(
    ellipse 80% 50% at 50% -20%,
    rgba(108, 92, 231, 0.08) 0%,
    transparent 70%
  );
}
```

A faint purple glow at the top of the page — subtle enough to add depth without being distracting.

## 7. What Gets Removed

- Gold gradient text (`.gold-text` class)
- Gold border utility (`.gold-border`)
- Card glow hover effect (`.card-glow:hover`)
- OKLch color definitions (replaced with hex for broader compatibility)
- Geist font imports
- Gold gradient top-line in header
- Gold/purple radial gradient background

## 8. Accessibility

- All text meets WCAG AA contrast (4.5:1 minimum against `--bg-primary` and `--bg-surface`)
- Confidence tier colors are supplemented with text labels (never color-only)
- Focus rings use `--color-primary` with 2px offset
- Touch targets: 44px minimum on mobile
- `prefers-reduced-motion` respected for all transitions

## What Comes Next

After this design system is implemented:
1. **Core Pages Rework** — Homepage, Feed, Props browser redesigned with new tokens
2. **Secondary Pages Rework** — Performance, Trends, Player, Game detail pages
