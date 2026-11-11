# Multi-Sport UI — Design (PARKED until WNBA backend ships)

**Date:** 2026-06-20
**Status:** Design approved; **implementation deferred** to SP-UI (the final WNBA-pivot sub-project).
**Why parked:** User chose "WNBA = full parity, built backend-first." WNBA's Edge/Trends/Performance/scored picks need the WNBA scoring backend (SP1b stats → SP2 calibration → SP3 scoring/grading) to exist first, or those pages would be empty. Build the backend, then this UI.

## Decisions (from the visual brainstorm; mockups in `.superpowers/brainstorm/369-1781994859/content/`)

1. **Sport-picker home.** `/` becomes a global sport picker (cards: NBA, WNBA, NBA Prediction Markets [deferred], "+ more sports"). Chosen because more sports are planned; the picker scales by adding cards.
2. **Per-sport path prefixes.** NBA moves under `/nba/*` (`/nba`, `/nba/edge`, `/nba/props`, …); WNBA under `/wnba/*`. Old NBA routes (`/props`, `/edge`, …) get **redirects** → `/nba/*` so bookmarks survive. `/api/*` routes do NOT move (the cron depends on them).
3. **NBA and WNBA are symmetric** — same nav, same page set, same scored-pick experience (LOCK/PLAY/FADE). WNBA is a genuine peer, not a reduced/"coming soon" section. (This is *why* the backend must come first.)
4. **Logo returns to the picker** from any sport section.
5. **NBA Prediction Markets (Kalshi)** is a future card/section, deferred — different data shape (market edges, not confidence props).

## Build order (revised)

SP1a (props, done) → **SP1b (WNBA stats)** → SP2 (backfill + calibration) → SP3 (scoring + grading) → **SP-UI (this design)**.

## When SP-UI is built, it will need

- A new `/` picker page; move NBA pages under `/nba/*`; redirects from legacy NBA paths.
- A `/wnba/*` section reusing the NBA page components, league-parameterized to read the `wnba_*` tables (props, grades, etc.) — mirroring the SP1a `LEAGUE_PROP_CONFIGS` pattern on the read/display side.
- Per-sport nav driven by a league context (so the same components serve both).
- Verification that NBA URLs/behaviour are unchanged behind the redirects, and WNBA pages populate from `wnba_*`.

This file captures the validated UX so SP-UI can go straight to a plan once the WNBA backend (SP1b–SP3) is in place.
