import { describe, it, expect } from 'vitest'
import { gradeParlay, logKey } from '../parlay-grade'

const leg = (player_name: string, stat_type = 'points', line = 20.5, direction = 'over') =>
  ({ player_name, stat_type, line, direction })
const log = (points: number, minutes = 30) => ({ points, minutes })

describe('gradeParlay', () => {
  // Regression: the grader ran at 04:21 UTC, five minutes before that night's game
  // logs landed, treated every missing log as DNP, and voided every parlay all season.
  it('waits (null) when the game date has no logs yet', () => {
    expect(gradeParlay([leg('A'), leg('B')], '2026-10-23', new Map(), new Set())).toBeNull()
  })

  it('voids only legs whose player has no log once the date is ingested', () => {
    const logs = new Map([[logKey('A', '2026-10-23'), log(25)]])
    const g = gradeParlay([leg('A'), leg('B')], '2026-10-23', logs, new Set(['2026-10-23']))!
    expect(g.result).toBe('hit')
    expect(g.legs.map((l) => l.hit)).toEqual([true, null])
  })

  it('misses when any playable leg misses', () => {
    const logs = new Map([[logKey('A', '2026-10-23'), log(25)], [logKey('B', '2026-10-23'), log(10)]])
    expect(gradeParlay([leg('A'), leg('B')], '2026-10-23', logs, new Set(['2026-10-23']))!.result).toBe('miss')
  })

  it('treats under-5-minute games as DNP and voids a parlay with no playable legs', () => {
    const logs = new Map([[logKey('A', '2026-10-23'), log(0, 2)]])
    expect(gradeParlay([leg('A')], '2026-10-23', logs, new Set(['2026-10-23']))!.result).toBe('void')
  })

  it('grades unders', () => {
    const logs = new Map([[logKey('A', '2026-10-23'), { rebounds: 3, minutes: 28 }]])
    expect(gradeParlay([leg('A', 'rebounds', 4.5, 'under')], '2026-10-23', logs, new Set(['2026-10-23']))!.result).toBe('hit')
  })
})


describe('gradeParlay name matching', () => {
  // Regression: leg "Darius Acuff" vs logs "Darius Acuff Jr." voided a leg he played.
  it('matches legs to logs across Jr./accents/punctuation', () => {
    const logs = new Map([[logKey('Darius Acuff Jr.', '2026-10-23'), { fg3m: 1, minutes: 30 }],
                          [logKey('Nikola Jokić', '2026-10-23'), { points: 30, minutes: 35 }]])
    const g = gradeParlay([leg('Darius Acuff', 'three_pointers', 1.5, 'under'), leg('Nikola Jokic', 'points', 25.5)],
      '2026-10-23', logs, new Set(['2026-10-23']))!
    expect(g.legs.map((l) => l.hit)).toEqual([true, true])
    expect(g.result).toBe('hit')
  })
})
