import { describe, it, expect } from 'vitest'
import { gradeProp, GRADE_CONFIGS } from '../grade'

const hist = (over: boolean, line: number, stat = 'points') =>
  ({ player_name: 'X', stat_type: stat, line, direction: over ? 'over' : 'under' })
const log = (over: Record<string, unknown>) => ({ minutes: 30, ...over })

describe('gradeProp', () => {
  it('over hits when actual exceeds line', () => {
    expect(gradeProp(hist(true, 24.5), log({ points: 30 }))).toEqual({ actual_value: 30, hit: true })
  })
  it('over misses when actual below line', () => {
    expect(gradeProp(hist(true, 24.5), log({ points: 20 }))).toEqual({ actual_value: 20, hit: false })
  })
  it('under hits when actual below line', () => {
    expect(gradeProp(hist(false, 24.5), log({ points: 20 }))).toEqual({ actual_value: 20, hit: true })
  })
  it('DNP (no log) -> null hit', () => {
    expect(gradeProp(hist(true, 24.5), undefined)).toEqual({ actual_value: null, hit: null })
  })
  it('DNP (under 5 minutes) -> null hit', () => {
    expect(gradeProp(hist(true, 24.5), { minutes: 3, points: 40 })).toEqual({ actual_value: null, hit: null })
  })
  it('played but stat is null -> skip (returns null)', () => {
    expect(gradeProp(hist(true, 24.5), { minutes: 30, points: null })).toBeNull()
  })
})

describe('GRADE_CONFIGS', () => {
  it('NBA targets NBA tables and requires a label', () => {
    const c = GRADE_CONFIGS.nba
    expect([c.historyTable, c.logsTable, c.gradesTable, c.requireLabel]).toEqual(['prop_history', 'player_game_logs', 'prop_grades', true])
  })
  it('WNBA targets wnba_* tables and does NOT require a label', () => {
    const c = GRADE_CONFIGS.wnba
    expect([c.historyTable, c.logsTable, c.gradesTable, c.requireLabel]).toEqual(['wnba_prop_history', 'wnba_player_game_logs', 'wnba_prop_grades', false])
  })
})
