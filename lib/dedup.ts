// Shared prop deduplication logic — collapses multi-book quotes for the same
// (player, stat, direction) into one main prop with the rest as alt lines.
//
// Selection rule (post-2026-05): pick the BEST LINE FOR THE DIRECTION at
// reasonable juice as the main, not the canonical/most-common line. Lower
// line = easier OVER hit; higher line = easier UNDER hit. The diagnostic
// pipeline (Module 6, model_diagnostic.py) showed that scoring against the
// best available line vs a worse-line book is worth ~12 percentage points
// of hit rate on the 19% of multi-book props where the lines disagree.
//
// Trade-off: OVER and UNDER for the same (player, stat) may now display at
// DIFFERENT lines (e.g. OVER 24.5 / UNDER 25.5) because each side's "best"
// is different. That's intentional — it reflects honest line-shopping.

import type { Prop, PropWithAlts, AltLine } from '@/types'

/** Reasonable book juice — outside this band the line is alt-priced and unreliable. */
function isReasonableJuice(odds: number | null | undefined): boolean {
  if (odds == null) return false
  const abs = Math.abs(odds)
  return abs >= 100 && abs <= 150
}

/** distance from -110 (the standard juice) — used as a tiebreaker. */
function distTo110(odds: number | null | undefined): number {
  if (odds == null) return Infinity
  return Math.abs(Math.abs(odds) - 110)
}

/** A is "more favorable" than B for the given direction. */
function isBetterLine(direction: 'over' | 'under', a: number, b: number): boolean {
  return direction === 'over' ? a < b : a > b
}

export function deduplicatePropsWithAlts(props: Prop[]): PropWithAlts[] {
  // Step 1: drop exact duplicates (same player|stat|line|direction|sportsbook).
  // When duplicates exist, keep the higher-confidence one.
  const exactSeen = new Map<string, Prop>()
  for (const prop of props) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.line}|${prop.direction}|${prop.sportsbook}`
    const ex = exactSeen.get(key)
    if (!ex || (prop.confidence_score ?? 0) > (ex.confidence_score ?? 0)) {
      exactSeen.set(key, prop)
    }
  }

  // Step 2: group by (player, stat, direction). Each group will become one
  // PropWithAlts: the best-line entry as main, the rest as altLines.
  const groups = new Map<string, Prop[]>()
  for (const prop of exactSeen.values()) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.direction}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(prop)
  }

  // Step 3: within each group, sort so the best-line/reasonable-juice prop is first.
  // Sort precedence:
  //   1. Has reasonable juice (real line, not alt-priced).
  //   2. Best line value for the direction (lowest for OVER, highest for UNDER).
  //   3. Odds closest to -110 (standard juice).
  //   4. Highest confidence score.
  const result: PropWithAlts[] = []
  for (const [, group] of groups) {
    if (group.length === 0) continue
    // Explicit normalization — any non-'under' falls back to 'over' rather than
    // a silent unchecked cast. Defensive for malformed upstream data.
    const direction: 'over' | 'under' = group[0].direction === 'under' ? 'under' : 'over'

    group.sort((a, b) => {
      const aJuice = isReasonableJuice(a.odds)
      const bJuice = isReasonableJuice(b.odds)
      if (aJuice !== bJuice) return aJuice ? -1 : 1

      // Best-line preference (only meaningful when both have real juice — otherwise
      // we'd be biased toward whichever side has more null-odds entries).
      if (aJuice && bJuice && a.line !== b.line) {
        return isBetterLine(direction, a.line, b.line) ? -1 : 1
      }

      // Both null-odds props produce Infinity − Infinity = NaN. Treat that as
      // "tied on juice distance" and fall through to the confidence tiebreak.
      const dist = distTo110(a.odds) - distTo110(b.odds)
      if (Number.isFinite(dist) && dist !== 0) return dist

      return (b.confidence_score ?? 0) - (a.confidence_score ?? 0)
    })

    const [main, ...rest] = group
    const altLines: AltLine[] = rest
      .filter((p) => p.line !== main.line || p.sportsbook !== main.sportsbook)
      .map((p): AltLine => ({
        line:             p.line,
        direction:        p.direction,
        odds:             p.odds,
        sportsbook:       p.sportsbook,
        confidence_score: p.confidence_score,
        confidence_label: p.confidence_label,
      }))
      .sort((a, b) => a.line - b.line)

    result.push({ ...main, altLines })
  }

  return result.sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
}
