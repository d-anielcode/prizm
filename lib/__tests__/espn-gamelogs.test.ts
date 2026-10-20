import { describe, it, expect } from 'vitest'
import { isPreseasonEvent } from '../espn-gamelogs'

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
