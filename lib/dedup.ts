// Shared prop deduplication logic — groups alt lines by player+stat+direction

import type { Prop, PropWithAlts, AltLine } from '@/types'

/**
 * Groups props by player+stat+direction.
 * Within each group, the "main" line is the one closest to standard -110 odds.
 * All other line values in the same direction become alt lines (with their own
 * confidence scores). Same-stat opposite-direction (OVER vs UNDER) remain as
 * separate main props.
 */
export function deduplicatePropsWithAlts(props: Prop[]): PropWithAlts[] {
  // Step 1: dedupe exact duplicates (same player|stat|line|direction|sportsbook)
  const exactSeen = new Map<string, Prop>()
  for (const prop of props) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.line}|${prop.direction}|${prop.sportsbook}`
    const ex = exactSeen.get(key)
    if (!ex || (prop.confidence_score ?? 0) > (ex.confidence_score ?? 0)) {
      exactSeen.set(key, prop)
    }
  }

  // Step 2: group by player+stat+direction (different line values = alt lines)
  const groups = new Map<string, Prop[]>()
  for (const prop of exactSeen.values()) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.direction}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(prop)
  }

  // Step 3: within each group, pick "main" = line closest to standard -110 odds
  const result: PropWithAlts[] = []
  for (const group of groups.values()) {
    // Sort by proximity to -110 (standard market line)
    group.sort((a, b) => {
      const distA = Math.abs(Math.abs(a.odds ?? -110) - 110)
      const distB = Math.abs(Math.abs(b.odds ?? -110) - 110)
      if (distA !== distB) return distA - distB
      // Tiebreak: prefer higher confidence
      return (b.confidence_score ?? 0) - (a.confidence_score ?? 0)
    })

    const [main, ...rest] = group
    const altLines: AltLine[] = rest
      .filter((p) => p.line !== main.line)   // drop same-line dupes from other sportsbooks
      .map((p): AltLine => ({
        line:              p.line,
        direction:         p.direction,
        odds:              p.odds,
        sportsbook:        p.sportsbook,
        confidence_score:  p.confidence_score,
        confidence_label:  p.confidence_label,
      }))
      .sort((a, b) => a.line - b.line)

    result.push({ ...main, altLines })
  }

  // Sort by confidence descending
  return result.sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
}
