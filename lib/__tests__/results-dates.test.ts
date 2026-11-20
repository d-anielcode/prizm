import { describe, it, expect } from 'vitest'
import { recentCompletedGameDates } from '../results-dates'

describe('recentCompletedGameDates', () => {
  // Regression: /api/results summarized the LIVE props table, so the answer depended
  // on which Hobby cron fired first; prop_results missed 2026-10-20..22 entirely.
  it('returns the previous N Eastern-time dates, newest first', () => {
    // 04:25 UTC Oct 24 = 00:25 ET Oct 24 -> last completed game days: Oct 23, 22, 21
    expect(recentCompletedGameDates(new Date('2026-10-24T04:25:00Z'), 3))
      .toEqual(['2026-10-23', '2026-10-22', '2026-10-21'])
  })

  it('uses the Eastern date, not UTC, late in the evening', () => {
    // 02:00 UTC Oct 24 = 22:00 ET Oct 23 -> tonight (Oct 23) isn't complete yet
    expect(recentCompletedGameDates(new Date('2026-10-24T02:00:00Z'), 2))
      .toEqual(['2026-10-22', '2026-10-21'])
  })
})
