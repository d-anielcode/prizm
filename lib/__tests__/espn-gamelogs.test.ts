import { describe, it, expect } from 'vitest'
import { isPreseasonEvent, espnGameDateToEt } from '../espn-gamelogs'

describe('isPreseasonEvent', () => {
  // Regression: Oct 2026 preseason box scores were stored as game logs and fed
  // opening-night hit rates and season averages.
  it('flags ESPN season type 1 (preseason)', () => {
    expect(isPreseasonEvent({ season: { year: 2027, type: 1, slug: 'preseason' } })).toBe(true)
  })

  it('keeps regular season, postseason and play-in games', () => {
    expect(isPreseasonEvent({ season: { year: 2027, type: 2 } })).toBe(false)
    expect(isPreseasonEvent({ season: { year: 2026, type: 3 } })).toBe(false)
    expect(isPreseasonEvent({ season: { year: 2026, type: 5 } })).toBe(false)
  })

  it('keeps events with no season info', () => {
    expect(isPreseasonEvent({})).toBe(false)
  })
})

describe('espnGameDateToEt', () => {
  // Regression: /api/gamelogs/player sliced the UTC timestamp, so a 9 PM ET tip
  // (02:00Z next day) was stored a day late and duplicated the correct row.
  it('maps a late-night UTC tip to the ET calendar date', () => {
    expect(espnGameDateToEt('2025-11-04T02:00:00.000+00:00')).toBe('2025-11-03')
    expect(espnGameDateToEt('2026-05-01T01:30Z')).toBe('2026-04-30')
  })

  it('keeps afternoon games on the same date', () => {
    expect(espnGameDateToEt('2025-12-25T17:00Z')).toBe('2025-12-25')
  })
})
