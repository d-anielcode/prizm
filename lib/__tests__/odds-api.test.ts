/**
 * Tests for odds-api slate selection.
 *
 * Regression: NBA games move to the `usa-nba-playoffs` league slug during the
 * postseason, so querying only `usa-nba` returned 0 events and the props slate
 * silently froze. fetchTodaysNBAEvents now merges multiple league slugs; the
 * pure selection logic is exercised here via selectEarliestSlate.
 */
import { describe, it, expect } from 'vitest'
import { selectEarliestSlate } from '../odds-api'
import { fetchEventsForLeagues, fetchTodaysWNBAEvents } from '../odds-api'

type RawEvent = { id: number; home: string; away: string; date: string; status: string }

describe('selectEarliestSlate', () => {
  it('returns [] for no events', () => {
    expect(selectEarliestSlate([])).toEqual([])
  })

  it('selects the earliest ET-date game and maps fields', () => {
    const events: RawEvent[] = [
      { id: 1, home: 'San Antonio', away: 'New York', date: '2026-06-14T00:30:00Z', status: 'pending' }, // Jun 13 ET
      { id: 2, home: 'New York', away: 'San Antonio', date: '2026-06-17T00:30:00Z', status: 'pending' }, // Jun 16 ET
    ]
    const slate = selectEarliestSlate(events)
    expect(slate).toHaveLength(1)
    expect(slate[0]).toMatchObject({
      id: '1', home_team: 'San Antonio', away_team: 'New York', commence_time: '2026-06-14T00:30:00Z',
    })
  })

  it('dedupes by id when two league queries overlap', () => {
    const events: RawEvent[] = [
      { id: 5, home: 'A', away: 'B', date: '2026-06-14T00:30:00Z', status: 'pending' },
      { id: 5, home: 'A', away: 'B', date: '2026-06-14T00:30:00Z', status: 'pending' },
    ]
    expect(selectEarliestSlate(events)).toHaveLength(1)
  })

  it('groups all games on the same earliest ET night (incl. post-midnight-UTC tip)', () => {
    const events: RawEvent[] = [
      { id: 1, home: 'A', away: 'B', date: '2026-06-14T00:30:00Z', status: 'pending' }, // Jun 13 ET 8:30p
      { id: 2, home: 'C', away: 'D', date: '2026-06-14T03:00:00Z', status: 'pending' }, // Jun 13 ET 11:00p
      { id: 3, home: 'E', away: 'F', date: '2026-06-17T00:30:00Z', status: 'pending' }, // Jun 16 ET
    ]
    expect(selectEarliestSlate(events).map((e) => e.id).sort()).toEqual(['1', '2'])
  })
})

describe('fetchEventsForLeagues', () => {
  it('throws when given no leagues (all-leagues-failed guard)', async () => {
    await expect(fetchEventsForLeagues([])).rejects.toThrow(/failed for all leagues/i)
  })
  it('exposes a WNBA convenience wrapper', () => {
    expect(typeof fetchTodaysWNBAEvents).toBe('function')
  })
})
