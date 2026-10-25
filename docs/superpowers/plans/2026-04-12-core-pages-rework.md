# Core Pages Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Homepage, Feed, and Props pages with better layouts, data density, and polish using Prizm 2.0 design tokens.

**Architecture:** Each page is reworked independently. The Homepage gets the biggest structural change (game strip + client-side game selection). Feed gets a compact streak bar + better parlay cards. Props gets polished filters and table rows. All use existing Prizm 2.0 tokens from `globals.css`.

**Tech Stack:** Next.js 16, React 19, Tailwind CSS v4, Supabase

---

### Task 1: Homepage Redesign — Game Strip + Props Drill-Down

**Files:**
- Modify: `app/page.tsx`
- Create: `components/HomeContent.tsx` (client component for game selection state)

This is the biggest change. The homepage currently shows a grid of large game cards with team logos. We're replacing it with:
1. A horizontal scrollable game strip (compact pills)
2. KPI tier summary row
3. Props list filtered to the selected game

- [ ] **Step 1: Create `components/HomeContent.tsx`**

This is a client component that receives the server-fetched data and manages game selection state.

```tsx
'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ConfidenceBadge } from './ConfidenceBadge'
import type { ConfidenceLabel } from '@/types'

interface GameInfo {
  game_id: string
  home_team: string | null
  away_team: string | null
  commence_time: string | null
  prop_count: number
}

interface PropSummary {
  player_name: string
  stat_type: string
  line: number
  direction: 'over' | 'under'
  confidence_score: number | null
  confidence_label: string | null
  game_id: string
  team?: string | null
}

const STAT_LABELS: Record<string, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST', steals: 'STL',
  blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

function teamAbbr(name: string | null): string {
  if (!name) return '???'
  // Common short names
  const ABBR: Record<string, string> = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
    'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
    'LA Clippers': 'LAC', 'LA Lakers': 'LAL',
  }
  return ABBR[name] ?? name.slice(0, 3).toUpperCase()
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET'
}

export function HomeContent({
  games,
  allProps,
  stale,
  gameDay,
}: {
  games: GameInfo[]
  allProps: PropSummary[]
  stale: boolean
  gameDay: string
}) {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(games[0]?.game_id ?? null)

  const lock = allProps.filter((p) => p.confidence_label === 'LOCK').length
  const play = allProps.filter((p) => p.confidence_label === 'PLAY').length
  const lean = allProps.filter((p) => p.confidence_label === 'LEAN').length
  const fade = allProps.filter((p) => p.confidence_label === 'FADE').length

  const selectedGame = games.find((g) => g.game_id === selectedGameId)
  const gameProps = allProps
    .filter((p) => p.game_id === selectedGameId && p.confidence_label !== 'FADE')
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
      {/* Stale warning */}
      {stale && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FFB800]/10 border border-[#FFB800]/20 text-[#FFB800] text-xs">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#FFB800] animate-pulse shrink-0" />
          Showing last cached slate — today&apos;s lines not yet available. Updates automatically by 8 AM ET.
        </div>
      )}

      {/* Page heading */}
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-bold text-foreground tracking-tight">{gameDay} Slate</h1>
        <span className="text-[var(--text-secondary)] text-sm">{games.length} games</span>
      </div>

      {/* Game strip — horizontal scrollable */}
      {games.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:-mx-6 sm:px-6 scrollbar-none">
          {games.map((game) => {
            const isActive = game.game_id === selectedGameId
            return (
              <button
                key={game.game_id}
                onClick={() => setSelectedGameId(game.game_id)}
                className={[
                  'flex-shrink-0 rounded-xl px-4 py-2.5 text-center transition-all duration-150 cursor-pointer min-w-[130px]',
                  isActive
                    ? 'bg-primary text-white shadow-[0_0_12px_rgba(108,92,231,0.25)]'
                    : 'bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)] hover:border-primary/40',
                ].join(' ')}
              >
                <div className="text-sm font-bold">{teamAbbr(game.away_team)} vs {teamAbbr(game.home_team)}</div>
                <div className={`text-[10px] mt-0.5 ${isActive ? 'text-white/70' : 'text-[var(--text-tertiary)]'}`}>
                  {formatTime(game.commence_time)}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* KPI tier summary */}
      <div className="flex gap-2">
        {[
          { count: lock, label: 'LOCK', color: '#00D68F' },
          { count: play, label: 'PLAY', color: '#FFB800' },
          { count: lean, label: 'LEAN', color: '#3B82F6' },
          { count: fade, label: 'FADE', color: '#FF4757' },
        ].map(({ count, label, color }) => (
          <div
            key={label}
            className="flex-1 rounded-lg py-2 text-center"
            style={{ background: `${color}15` }}
          >
            <div className="text-lg font-bold font-mono" style={{ color }}>{count}</div>
            <div className="text-[10px] text-[var(--text-secondary)] font-semibold">{label}</div>
          </div>
        ))}
      </div>

      {/* Props for selected game */}
      {selectedGame && gameProps.length > 0 && (
        <div>
          <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider font-semibold mb-3">
            {teamAbbr(selectedGame.away_team)} vs {teamAbbr(selectedGame.home_team)} &middot; Top Props
          </div>
          <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden shadow-[var(--shadow-card)]">
            {gameProps.map((prop, i) => (
              <Link
                key={`${prop.player_name}-${prop.stat_type}-${prop.line}-${prop.direction}`}
                href={`/props?search=${encodeURIComponent(prop.player_name)}`}
                className={[
                  'flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-surface-2)] transition-colors duration-150',
                  i < gameProps.length - 1 ? 'border-b border-[var(--border-subtle)]' : '',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-foreground">{prop.player_name}</span>
                  <span className="text-xs text-[var(--text-secondary)] font-mono">
                    {prop.direction === 'over' ? 'O' : 'U'} {prop.line} {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                  </span>
                </div>
                {prop.confidence_label && prop.confidence_score != null && (
                  <ConfidenceBadge label={prop.confidence_label as ConfidenceLabel} score={prop.confidence_score} />
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      {selectedGame && gameProps.length === 0 && (
        <div className="py-12 text-center text-[var(--text-tertiary)] text-sm">
          No scored props for this game yet.
        </div>
      )}

      {games.length === 0 && (
        <div className="py-16 text-center text-[var(--text-tertiary)]">
          No upcoming games found. Props refresh automatically by 8 AM ET.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `app/page.tsx` to use HomeContent**

Keep all the existing data fetching functions (`getData`, `getResults`, `getGameDay`, `deduplicateProps`, etc.) exactly as they are. Replace ONLY the `HomePage` default export and remove the `TeamSide` component, `TodaysPicks` import, and the `Image` import (no longer needed).

The new `HomePage` export:

```tsx
export default async function HomePage() {
  const [{ games, allProps, stale }, results] = await Promise.all([getData(), getResults()])
  const gameDay = getGameDay(games)

  // Serialize props to the minimal shape HomeContent needs
  const propSummaries = allProps.map((p) => ({
    player_name: p.player_name,
    stat_type: p.stat_type,
    line: p.line,
    direction: p.direction as 'over' | 'under',
    confidence_score: p.confidence_score ?? null,
    confidence_label: p.confidence_label ?? null,
    game_id: p.game_id,
    team: p.team ?? null,
  }))

  return (
    <>
      <HomeContent games={games} allProps={propSummaries} stale={stale} gameDay={gameDay} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-10 flex flex-col gap-8">
        <ConfidenceExplainer />
        {results.length > 0 && <ResultsHistory results={results} />}
      </div>
    </>
  )
}
```

Remove:
- `import Image from 'next/image'`
- `import { TodaysPicks } from '@/components/TodaysPicks'`
- The entire `TeamSide` component function
- The `teamLogoUrl` function (no longer used on homepage)

Add:
- `import { HomeContent } from '@/components/HomeContent'`

- [ ] **Step 3: Verify the app builds and the homepage renders**

Run: `npx next build`
Then start dev server and check homepage visually.

- [ ] **Step 4: Commit**

```bash
git add components/HomeContent.tsx app/page.tsx
git commit -m "feat(pages): redesign homepage with game strip + props drill-down"
```

---

### Task 2: Feed Page Redesign — Compact Streak + Stacked Parlays

**Files:**
- Modify: `app/feed/page.tsx`

The Feed page needs these changes:
1. Compact the streak section from a large card to a single-row bar
2. Show all parlay legs by default (no collapsed state)
3. Premium/Jackpot parlays get a purple accent border
4. Update all remaining old color references to Prizm 2.0 tokens
5. Change max-width to `max-w-5xl`

- [ ] **Step 1: Read the full current feed page**

Read `app/feed/page.tsx` completely to understand the existing structure before making changes.

- [ ] **Step 2: Update the `labelStyle` function**

Replace the `labelStyle` function (around line 130-135) with:

```tsx
function labelStyle(label: string | undefined) {
  if (label === 'LOCK') return 'text-[#00D68F] bg-[#00D68F]/10 border-[#00D68F]/25'
  if (label === 'PLAY') return 'text-[#FFB800] bg-[#FFB800]/10 border-[#FFB800]/25'
  if (label === 'LEAN') return 'text-[#3B82F6] bg-[#3B82F6]/10 border-[#3B82F6]/25'
  return 'text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border-[var(--border-default)]'
}
```

- [ ] **Step 3: Update the `resultBadge` function**

Replace with:

```tsx
function resultBadge(result?: 'hit' | 'miss' | 'void' | null) {
  if (!result) return null
  if (result === 'hit')  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border text-[#00D68F] bg-[#00D68F]/10 border-[#00D68F]/25">HIT</span>
  if (result === 'miss') return <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border text-[#FF4757] bg-[#FF4757]/10 border-[#FF4757]/25">MISS</span>
  return <span className="text-[10px] font-bold px-2 py-0.5 rounded-md border text-[var(--text-tertiary)] bg-[var(--bg-surface-2)] border-[var(--border-default)]">VOID</span>
}
```

- [ ] **Step 4: Redesign the streak section in the JSX**

Find the streak section in the `FeedPage` render (the large "Daily Streak" card). Replace it with a compact single-row bar:

```tsx
{/* Compact streak bar */}
<div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl px-4 py-3 flex items-center justify-between">
  <div className="flex items-center gap-3">
    <span className="text-sm font-semibold text-foreground">Daily Streak</span>
    <div className="flex gap-1">
      {bars.map((bar, i) => (
        <div
          key={i}
          className={[
            'w-4 h-4 rounded-sm',
            bar === 'hit' ? 'bg-[#00D68F]' :
            bar === 'miss' ? 'bg-[#FF4757]' :
            bar === 'pending' ? 'bg-[#FFB800]' :
            'bg-[var(--bg-surface-2)] border border-[var(--border-default)]',
          ].join(' ')}
        />
      ))}
    </div>
  </div>
  <span className="text-xl font-bold font-mono text-[#00D68F]">{currentStreak}</span>
</div>
```

Note: The `bars` array already exists in the current code — it's computed from the streak history. Keep that logic, just replace the visual rendering.

- [ ] **Step 5: Update parlay card styling**

For each parlay card in the date-grouped render loop, apply these style changes:

- Card container: `bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden shadow-[var(--shadow-card)]`
- Premium/Jackpot cards: `border-primary/30` instead of `border-[var(--border-default)]`
- Card header: `px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between`
- Multiplier badge: `bg-primary/15 text-[#A29BFE] px-2 py-0.5 rounded-md text-xs font-semibold font-mono`
- Leg rows: `px-4 py-2.5 flex items-center justify-between border-b border-[var(--border-subtle)] last:border-b-0`
- Player name in legs: `font-semibold text-sm text-foreground`
- Stat line in legs: `text-xs text-[var(--text-secondary)] font-mono ml-2`
- Confidence label in legs: use tier color text only (no badge needed, just colored text)

- [ ] **Step 6: Update the page wrapper**

Change the outermost `<div>` from whatever max-width it uses to `max-w-5xl mx-auto px-4 sm:px-6 py-6`.

- [ ] **Step 7: Update remaining color references**

Search the file for any remaining old color patterns:
- `violet-400` / `emerald-400` → use new tier colors
- `white/30` / `white/25` → `var(--text-tertiary)` or `var(--text-secondary)`
- `white/[0.07]` → `var(--border-subtle)`
- `#FFB800` for odds → keep (it's the correct amber)

- [ ] **Step 8: Verify build and visual check**

Run: `npx next build`
Check the feed page in dev server.

- [ ] **Step 9: Commit**

```bash
git add app/feed/page.tsx
git commit -m "feat(pages): redesign feed with compact streak bar + stacked parlay cards"
```

---

### Task 3: Props Page Polish — Filters + Table Rows

**Files:**
- Modify: `components/PropsTable.tsx`
- Modify: `app/props/page.tsx`

The Props page keeps its filterable table layout but gets polished filters and cleaner table rows.

- [ ] **Step 1: Read both files completely**

Read `components/PropsTable.tsx` and `app/props/page.tsx` fully before making changes.

- [ ] **Step 2: Update tier filter buttons in PropsTable.tsx**

Find the tier filter buttons section. The active/inactive states should use solid tint backgrounds:

```tsx
// Tier filter buttons — solid tint when active, surface-2 when inactive
const TIER_STYLES: Record<string, { active: string; inactive: string }> = {
  LOCK: {
    active: 'bg-[#00D68F]/20 text-[#00D68F] border-[#00D68F]/30',
    inactive: 'bg-[var(--bg-surface-2)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[#00D68F]/30',
  },
  PLAY: {
    active: 'bg-[#FFB800]/20 text-[#FFB800] border-[#FFB800]/30',
    inactive: 'bg-[var(--bg-surface-2)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[#FFB800]/30',
  },
  LEAN: {
    active: 'bg-[#3B82F6]/20 text-[#3B82F6] border-[#3B82F6]/30',
    inactive: 'bg-[var(--bg-surface-2)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[#3B82F6]/30',
  },
  FADE: {
    active: 'bg-[#FF4757]/20 text-[#FF4757] border-[#FF4757]/30',
    inactive: 'bg-[var(--bg-surface-2)] text-[var(--text-secondary)] border-[var(--border-default)] hover:border-[#FF4757]/30',
  },
}
```

Each tier filter button should use `rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer` as base classes, with the active/inactive variant applied based on selection state.

- [ ] **Step 3: Update stat type and direction chips**

Stat type chips active state: `bg-primary/15 border-primary/30 text-[#A29BFE]`
Stat type chips inactive state: `bg-[var(--bg-surface-2)] border-[var(--border-default)] text-[var(--text-secondary)] hover:border-primary/30`

Direction chips: same pattern as stat type chips.

All chips: `rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-150 cursor-pointer`

- [ ] **Step 4: Update search input styling**

Find the search input. Update classes to:
```
bg-[var(--bg-surface-2)] border border-[var(--border-default)] rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-[var(--text-tertiary)] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 w-full
```

- [ ] **Step 5: Add divider between filters and results**

Add a subtle horizontal divider between the filter section and the props table:
```tsx
<div className="border-t border-[var(--border-subtle)] my-2" />
```

- [ ] **Step 6: Update prop row styling**

Each prop row should have:
- Minimum height: `min-h-[44px]` (touch target compliance)
- Padding: `px-4 py-3`
- Alternating tint: odd rows get `bg-[var(--bg-surface)]/50`
- Hover: `hover:bg-[var(--bg-surface-2)]`
- Player name: `font-semibold text-sm text-foreground`
- Stat line: `text-xs text-[var(--text-secondary)] font-mono`
- Border between rows: `border-b border-[var(--border-subtle)]`

- [ ] **Step 7: Update `app/props/page.tsx` max-width**

Change the outermost container from whatever max-width it uses to `max-w-5xl mx-auto px-4 sm:px-6 py-6`.

- [ ] **Step 8: Verify build and visual check**

Run: `npx next build`
Check the props page in dev server.

- [ ] **Step 9: Commit**

```bash
git add components/PropsTable.tsx app/props/page.tsx
git commit -m "feat(pages): polish props page filters, search input, and table rows"
```

---

### Task 4: Commit Docs + Final Visual Verify

**Files:**
- Add: `docs/superpowers/specs/2026-04-12-core-pages-rework-design.md`
- Add: `docs/superpowers/plans/2026-04-12-core-pages-rework.md`

- [ ] **Step 1: Start dev server and check all 3 pages**

Run the dev server and visually verify:

**Homepage:** Game strip scrolls horizontally, clicking a game filters props below, KPI tier summary shows correct numbers, props list shows LOCK/PLAY/LEAN only, no team logos (text abbreviations only).

**Feed:** Compact streak bar (single row), parlay cards show all legs by default, premium/jackpot have purple border, multiplier badges are purple tint.

**Props:** Tier filter buttons have solid tint backgrounds, stat/direction chips match new styling, search input has purple focus ring, table rows have alternating tint and sufficient height.

- [ ] **Step 2: Commit docs**

```bash
git add docs/superpowers/specs/2026-04-12-core-pages-rework-design.md docs/superpowers/plans/2026-04-12-core-pages-rework.md
git commit -m "docs: add core pages rework spec and plan"
```
