# Core Pages Rework — Design Spec

**Date:** 2026-04-12
**Goal:** Redesign the Homepage, Feed, and Props pages with better layouts, data density, and polish using the Prizm 2.0 design system tokens.

## Scope

Three pages redesigned:
1. **Homepage** (`app/page.tsx`) — Game strip + KPI tier summary + props drill-down
2. **Feed** (`app/feed/page.tsx`) — Compact streak bar + stacked parlay cards
3. **Props** (`app/props/page.tsx` + `components/PropsTable.tsx`) — Polished filterable table

No new data fetching or API changes. All changes are layout/styling/component-level.

## 1. Homepage Redesign

### Current Problems
- Tier counts are bare numbers with no visual weight
- Game cards are large with team logos taking too much space
- No way to quickly see which games have the best picks
- `max-w-7xl` makes content too wide on desktop

### New Layout (top to bottom)

```
┌─────────────────────────────────────────┐
│ "Apr 12's Slate · 7 games"  (heading)   │
│ [Stale warning if applicable]           │
├─────────────────────────────────────────┤
│ ← [BOS vs NYK] [LAL vs DEN] [MIA v →   │  ← Horizontal scrollable game strip
│    7:30 PM      10:00 PM     8:00 PM    │     Active game = purple bg, rest = surface
├─────────────────────────────────────────┤
│  3 LOCK  │  12 PLAY  │  89 LEAN │ 64 F │  ← KPI tier summary (compact pills)
├─────────────────────────────────────────┤
│ BOS vs NYK · Top Props                  │  ← Section header for selected game
│ ┌─────────────────────────────────────┐ │
│ │ J. Tatum    O 26.5 PTS     82 LOCK │ │  ← Props list for selected game
│ │ J. Brunson  O 7.5 AST      71 PLAY │ │
│ │ K. Porzingis O 2.5 BLK     58 LEAN │ │
│ │ ... more props ...                  │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ [How Prizm Works] expandable            │
├─────────────────────────────────────────┤
│ Results History (last 14 days)          │
└─────────────────────────────────────────┘
```

### Game Strip Component
- Horizontal scrollable row of game "pills" (not full cards)
- Each pill: `{AWAY} vs {HOME}` + time, on a `bg-surface` card with `border-default`
- Selected game pill: `bg-primary` with white text
- First game is selected by default
- Clicking a game pill filters the props list below to that game
- Client component (needs click state) wrapping a server-rendered prop list

### KPI Tier Summary
- 4 compact pills in a row: `3 LOCK`, `12 PLAY`, `89 LEAN`, `64 FADE`
- Each pill uses its tier's bg tint color (same as ConfidenceBadge)
- Monospace numbers (`font-mono`)
- These are totals across ALL games, not just the selected one

### Props List for Selected Game
- Section header: `"{AWAY} vs {HOME} · Top Props"` in `text-secondary`
- List rows: player name, stat line, ConfidenceBadge (right-aligned)
- Rows are clickable → link to `/props?search={player_name}`
- Only show LOCK + PLAY + LEAN props for the selected game (hide FADE to keep it actionable)
- Sort by confidence_score descending

### Changes to `app/page.tsx`
- Convert to a hybrid: server component fetches data, wraps a client `HomeContent` component
- `HomeContent` manages selected game state
- Remove `TodaysPicks` from homepage (moved to Feed)
- Remove large team logo `Image` components — use text abbreviations only in game strip
- Change `max-w-7xl` to `max-w-5xl`

## 2. Feed Page Redesign

### Current Problems
- Daily Streak card is too large and takes up the whole viewport
- Parlays don't show leg details without expanding
- Visual hierarchy doesn't emphasize parlays enough

### New Layout (top to bottom)

```
┌─────────────────────────────────────────┐
│ "Feed"  "Daily streaks and parlays"     │
├─────────────────────────────────────────┤
│ Daily Streak [■■■□□□□□□□] 3             │  ← Compact single-row streak bar
├─────────────────────────────────────────┤
│ APR 12                                  │  ← Date header
│ ┌─────────────────────────────────────┐ │
│ │ Safe Pick         3 legs       x2.8 │ │  ← Parlay card header
│ │─────────────────────────────────────│ │
│ │ J. Tatum  O 26.5 PTS         LOCK  │ │  ← Visible legs
│ │ A. Davis  O 10.5 REB         PLAY  │ │
│ │ D. Mitchell O 6.5 AST        PLAY  │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ High Roller      4 legs       x6.2 │ │  ← Premium parlay (purple border)
│ │─────────────────────────────────────│ │
│ │ ... legs ...                        │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ Jackpot          5 legs      x14.3 │ │
│ │─────────────────────────────────────│ │
│ │ ... legs ...                        │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│ APR 11                                  │  ← Previous date
│ [graded parlays with hit/miss status]   │
└─────────────────────────────────────────┘
```

### Compact Streak Bar
- Single row: "Daily Streak" label + colored squares (green = hit, red = miss, gray = pending) + streak count
- Height: ~48px total (not a full card)
- Background: `bg-surface` with `border-default`

### Parlay Cards
- Card header: parlay title (Safe Pick/High Roller/Jackpot) + leg count + multiplier
- Multiplier badge: purple tint bg with `text-primary-light`
- Legs listed vertically: player name, stat line, ConfidenceBadge
- Premium/Jackpot parlays: `border-primary/30` instead of `border-default`
- Past parlays with results: green header (hit) or red header (miss) with result badge
- Pass 2 replacements: small "Updated" badge on the card header

### Changes to `app/feed/page.tsx`
- Restructure the streak section to be a single compact bar (not a large card)
- Parlay cards show all legs by default (no expand/collapse needed)
- Group by date with date headers
- Change `max-w` to `max-w-5xl`

## 3. Props Page Polish

### Current Problems
- Tier filter buttons are pill-shaped outlines that don't stand out
- Stat type chips are hard to scan
- Search input blends into background
- No visual hierarchy between filters and results

### Changes

#### Filter Section
- Tier filter buttons: use solid tint backgrounds (like KPI pills on homepage) instead of outlined pills
- Active filter: solid tier color bg. Inactive: `bg-surface-2` with `text-secondary`
- Stat type chips: same pattern — active gets `bg-primary-dim` + `border-primary` + `text-primary-light`
- Direction chips: same active/inactive pattern
- Search input: `bg-surface-2` with `border-default`, `focus:border-primary` ring
- Add a subtle divider between filters section and results table

#### Props Table Rows
- Slightly increase row padding for better touch targets (44px minimum row height)
- Player name: `font-semibold text-foreground`
- Stat line: `text-secondary font-mono`
- ConfidenceBadge: right-aligned, using new tier colors (already done in design system)
- Alternating row tinting: every other row gets `bg-surface/50` for scanability

#### Changes to `components/PropsTable.tsx`
- Update filter chip styling to use new token pattern
- Update search input styling
- Add alternating row tinting
- Ensure minimum 44px row height
- Change max-width references to `max-w-5xl`

## Design Tokens Used

All pages use the Prizm 2.0 tokens from `globals.css`:
- Backgrounds: `--bg-surface`, `--bg-surface-2`, `--bg-surface-3`
- Text: `--text-primary`, `--text-secondary`, `--text-tertiary`
- Borders: `--border-default`, `--border-subtle`
- Tiers: `--color-lock`, `--color-play`, `--color-lean`, `--color-fade`
- Brand: `--color-primary` (#6C5CE7), `--color-primary-light` (#A29BFE)
- Shadows: `--shadow-card`

## What This Does NOT Do

- No new API routes or data fetching changes
- No database schema changes
- No changes to secondary pages (Performance, Trends, Player, Game detail)
- No changes to the design system tokens themselves
- No new npm dependencies
