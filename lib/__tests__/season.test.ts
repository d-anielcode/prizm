import { describe, it, expect } from 'vitest'
import { shiftSeason, seasonDateRange, pickSeasonRows } from '../season'

describe('season helpers', () => {
  it('shifts season ids', () => {
    expect(shiftSeason('2026-27', -1)).toBe('2025-26')
    expect(shiftSeason('1999-00', 1)).toBe('2000-01')
  })

  it('maps a season to an Oct 1 → Sep 30 window', () => {
    expect(seasonDateRange('2026-27')).toEqual({ start: '2026-10-01', end: '2027-09-30' })
  })
})

describe('pickSeasonRows', () => {
  const row = (player_name: string, season: string, games_played: number) => ({ player_name, season, games_played })

  it('uses last season until the current season has enough games', () => {
    const m = pickSeasonRows([row('A', '2026-27', 2), row('A', '2025-26', 70)], '2026-27')
    expect(m.get('A')?.season).toBe('2025-26')
  })

  it('switches to the current season once the sample is big enough', () => {
    const m = pickSeasonRows([row('A', '2026-27', 5), row('A', '2025-26', 70)], '2026-27')
    expect(m.get('A')?.season).toBe('2026-27')
  })

  it('keeps a small current-season row for rookies with no prior season', () => {
    const m = pickSeasonRows([row('R', '2026-27', 1)], '2026-27')
    expect(m.get('R')?.season).toBe('2026-27')
  })

  it('ignores seasons older than last season', () => {
    const m = pickSeasonRows([row('A', '2024-25', 80)], '2026-27')
    expect(m.has('A')).toBe(false)
  })
})
