import { describe, it, expect } from 'vitest'
import { shiftSeason, seasonDateRange, pickSeasonRows, groupSeasonLogs } from '../season'

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

describe('groupSeasonLogs', () => {
  const log = (player_name: string, nba_id: string | number | null, game_date: string, points = 10) =>
    ({ player_name, nba_id, game_date, points })

  // Regression: logs carry ESPN ids from one writer and NBA.com ids from another,
  // and accented/plain spellings; keying by nba_id split one player into two rows.
  it('merges one player across id systems and spellings, counting each date once', () => {
    const groups = groupSeasonLogs([
      log('Nikola Jokic', 3112335, '2025-11-22', 44),
      log('Nikola Jokić', 203999, '2025-11-22', 44),
      log('Nikola Jokic', 3112335, '2025-11-24', 30),
      log('Victor Wembanyama', '5104157', '2025-11-01'),
      log('Victor Wembanyama', '1641705', '2025-11-03'),
      log('Victor Wembanyama', '1641705', '2025-11-05'),
    ])
    const jokic = groups.find((g) => g.player_name === 'Nikola Jokic')!
    expect(jokic.logs.map((l) => l.game_date)).toEqual(['2025-11-22', '2025-11-24'])
    expect(jokic.nba_id).toBe('3112335')
    const wemby = groups.find((g) => g.player_name === 'Victor Wembanyama')!
    expect(wemby.logs).toHaveLength(3)
    expect(wemby.nba_id).toBe('1641705') // most-used id wins
    expect(groups).toHaveLength(2)
  })

  it('falls back to a local id when no log has one', () => {
    const [g] = groupSeasonLogs([log('New Guy', null, '2025-11-01')])
    expect(g.nba_id).toBe('local_New Guy')
  })
})
