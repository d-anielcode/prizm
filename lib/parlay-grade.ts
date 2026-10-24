// Pure grading for curated parlays (feed). Sportsbook rules: a DNP leg is voided
// and removed; the parlay only fully voids when no playable legs remain.

import type { StatType } from '@/types'

export interface ParlayLeg {
  player_name: string
  stat_type: string
  line: number | string
  direction: string
}

export interface LegGrade {
  player_name: string
  stat_type: string
  line: number
  direction: string
  actual: number | null
  hit: boolean | null  // null = DNP / no log
}

const MIN_MINUTES = 5

function actualValue(log: Record<string, unknown>, statType: string): number | null {
  switch (statType as StatType) {
    case 'points':         return Number(log.points   ?? 0)
    case 'rebounds':       return Number(log.rebounds ?? 0)
    case 'assists':        return Number(log.assists  ?? 0)
    case 'steals':         return Number(log.steals   ?? 0)
    case 'blocks':         return Number(log.blocks   ?? 0)
    case 'three_pointers': return Number(log.fg3m     ?? 0)
    case 'pra':            return Number(log.pra      ?? 0)
    default:               return null
  }
}

/**
 * Grade one parlay. Returns null when `gameDate` has no game logs yet: a missing
 * log only means "did not play" once that night's box scores have been fetched.
 * logIndex is keyed `${player_name}|${game_date}`.
 */
export function gradeParlay(
  legs: ParlayLeg[],
  gameDate: string,
  logIndex: Map<string, Record<string, unknown>>,
  datesWithLogs: Set<string>,
): { legs: LegGrade[]; result: 'hit' | 'miss' | 'void' } | null {
  if (!datesWithLogs.has(gameDate)) return null
  const graded = legs.map((l): LegGrade => {
    const log = logIndex.get(`${l.player_name}|${gameDate}`)
    const played = log && Number(log.minutes ?? 0) >= MIN_MINUTES
    const actual = played ? actualValue(log, l.stat_type) : null
    const line = Number(l.line)
    const hit = actual === null ? null : l.direction === 'over' ? actual > line : actual < line
    return { player_name: l.player_name, stat_type: l.stat_type, line, direction: l.direction, actual, hit }
  })
  const playable = graded.filter((l) => l.hit !== null)
  const result = playable.length === 0 ? 'void' : playable.some((l) => l.hit === false) ? 'miss' : 'hit'
  return { legs: graded, result }
}
