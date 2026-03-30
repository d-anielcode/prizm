// Shared prop deduplication logic — groups alt lines by player+stat+direction

import type { Prop, PropWithAlts, AltLine } from '@/types'

/**
 * Groups props by player+stat+direction.
 * Within each group, the "main" line is determined by the canonical line —
 * the line that appears in BOTH over AND under at closest to -110 odds.
 * This ensures OVER and UNDER always share the same main line (e.g. both at 9.5,
 * not OVER 9.5 / UNDER 4.5 which are alt lines at different values).
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

  // Step 2: find canonical line per player+stat.
  // The canonical line is what the sportsbook uses for the "main" prop —
  // the same line appears in both OVER and UNDER at ~-110 juice.
  const byPlayerStat = new Map<string, { over: Prop[]; under: Prop[] }>()
  for (const prop of exactSeen.values()) {
    const key = `${prop.player_name}|${prop.stat_type}`
    if (!byPlayerStat.has(key)) byPlayerStat.set(key, { over: [], under: [] })
    byPlayerStat.get(key)![prop.direction as 'over' | 'under'].push(prop)
  }

  function distTo110(odds: number | undefined) {
    return Math.abs(Math.abs(odds ?? -110) - 110)
  }

  const canonicalLine = new Map<string, number>() // "player|stat" → canonical line value
  for (const [key, { over, under }] of byPlayerStat) {
    if (over.length === 0) continue

    if (under.length > 0) {
      // Prefer a line that appears in BOTH directions — that's the sportsbook main line
      const overLineSet = new Set(over.map((p) => p.line))
      const sharedLines = under.filter((p) => overLineSet.has(p.line)).map((p) => p.line)

      if (sharedLines.length > 0) {
        // Among shared lines, pick the one where the over is closest to -110
        const best = sharedLines.sort((a, b) => {
          const oA = over.find((p) => p.line === a)
          const oB = over.find((p) => p.line === b)
          return distTo110(oA?.odds) - distTo110(oB?.odds)
        })[0]
        canonicalLine.set(key, best)
        continue
      }
    }

    // No shared lines (or no under props) — fall back to over line closest to -110
    const mainOver = [...over].sort((a, b) => distTo110(a.odds) - distTo110(b.odds))[0]
    canonicalLine.set(key, mainOver.line)
  }

  // Step 3: group by player+stat+direction, pick main = canonical line.
  // For UNDER props the API often omits the standard line and only returns low
  // alt lines with missing odds. If no exact match exists for the canonical line,
  // fall back to the UNDER line numerically closest to the canonical value so
  // OVER 9.5 / UNDER 9.5 (or 8.5) are shown rather than OVER 9.5 / UNDER 4.5.
  const groups = new Map<string, Prop[]>()
  for (const prop of exactSeen.values()) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.direction}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(prop)
  }

  const result: PropWithAlts[] = []
  for (const [groupKey, group] of groups) {
    const psKey = groupKey.split('|').slice(0, 2).join('|') // "player|stat"
    const canon = canonicalLine.get(psKey)

    // Sort: canonical line first, then by numerical proximity to canonical (for
    // under groups where canonical line may not exist), then by proximity to -110,
    // then confidence.
    group.sort((a, b) => {
      const aCanon = a.line === canon ? 0 : 1
      const bCanon = b.line === canon ? 0 : 1
      if (aCanon !== bCanon) return aCanon - bCanon
      // If no canonical match, prefer line closest in value to canonical
      if (canon !== undefined) {
        const numDistDiff = Math.abs(a.line - canon) - Math.abs(b.line - canon)
        if (numDistDiff !== 0) return numDistDiff
      }
      const distDiff = distTo110(a.odds) - distTo110(b.odds)
      if (distDiff !== 0) return distDiff
      return (b.confidence_score ?? 0) - (a.confidence_score ?? 0)
    })

    const [main, ...rest] = group
    const altLines: AltLine[] = rest
      .filter((p) => p.line !== main.line)
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
