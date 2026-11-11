import { describe, it, expect, vi } from 'vitest'

// Mock heavy server-side modules that throw during module init without env vars
vi.mock('@/lib/supabase', () => ({
  supabase: {},
  isCacheStale: vi.fn(),
  safeQuery: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireCronAuth: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@/lib/dedup', () => ({ deduplicatePropsWithAlts: vi.fn() }))
vi.mock('@/lib/odds-api', () => ({
  fetchTodaysNBAEvents: vi.fn(),
  fetchTodaysWNBAEvents: vi.fn(),
  fetchAllPropsForEvents: vi.fn(),
}))
vi.mock('next/server', () => ({ NextResponse: { json: vi.fn() } }))

import { LEAGUE_PROP_CONFIGS } from '../props-refresh'

describe('LEAGUE_PROP_CONFIGS', () => {
  it('NBA config targets the NBA tables', () => {
    const c = LEAGUE_PROP_CONFIGS.nba
    expect([c.propsTable, c.altsTable, c.historyTable]).toEqual(['props', 'prop_alts', 'prop_history'])
  })
  it('WNBA config targets the wnba_* tables', () => {
    const c = LEAGUE_PROP_CONFIGS.wnba
    expect([c.propsTable, c.altsTable, c.historyTable]).toEqual(['wnba_props', 'wnba_prop_alts', 'wnba_prop_history'])
  })
  it('each config carries an events fetcher and league tag', () => {
    expect(LEAGUE_PROP_CONFIGS.nba.league).toBe('nba')
    expect(typeof LEAGUE_PROP_CONFIGS.wnba.fetchEvents).toBe('function')
  })
})

describe('snapshotUnscored', () => {
  it('WNBA snapshots unscored props; NBA does not', () => {
    expect(LEAGUE_PROP_CONFIGS.wnba.snapshotUnscored).toBe(true)
    expect(LEAGUE_PROP_CONFIGS.nba.snapshotUnscored ?? false).toBe(false)
  })
})
