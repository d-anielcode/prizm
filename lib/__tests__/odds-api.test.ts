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
import { fetchEventsForLeagues, fetchTodaysWNBAEvents, isPlayerName, parsePropsFromEvent } from '../odds-api'

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

describe('isPlayerName', () => {
  it('accepts real player names', () => {
    expect(isPlayerName('Jayson Tatum', 'Detroit Pistons', 'Boston Celtics')).toBe(true)
  })

  // Regression: "Any Player (Threes)" style markets were scored as a player prop.
  it('rejects the generic "Any Player" market', () => {
    expect(isPlayerName('Any Player', 'Detroit Pistons', 'Boston Celtics')).toBe(false)
  })

  it('rejects team-total markets', () => {
    expect(isPlayerName('Both Teams')).toBe(false)
    expect(isPlayerName('Boston Celtics', 'Detroit Pistons', 'Boston Celtics')).toBe(false)
  })
})

describe('parsePropsFromEvent odds sanity', () => {
  const event = (over: string, under: string) => ({
    id: 1, home_team: 'Detroit Pistons', away_team: 'Boston Celtics', commence_time: '2026-10-20T23:00:00Z',
    bookmakers: { DraftKings: [{ odds: [{ label: 'Jayson Tatum (Points)', hdp: 26.5, over, under }] }] },
  }) as unknown as Parameters<typeof parsePropsFromEvent>[0]

  it('keeps normally priced sides', () => {
    const props = parsePropsFromEvent(event('1.91', '1.91'))
    expect(props.map((p) => p.direction)).toEqual(['over', 'under'])
    expect(props[0].odds).toBe(-110)
  })

  // Regression: -10000 / +3000 quotes (decimal 1.01 / 31) reached prop_history.
  it('drops sides priced outside -500..+500', () => {
    const props = parsePropsFromEvent(event('1.01', '31'))
    expect(props).toHaveLength(0)
  })
})
