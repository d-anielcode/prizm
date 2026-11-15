import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/calibration', () => ({ applyCalibration: (s: number) => s }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { loadTodayPicks } from '@/lib/kalshi/model-picks-data'
import { logger } from '@/lib/logger'

const now = new Date('2026-11-11T23:00:00Z')
const market = {
  ticker: 'KXNBAPTS-26NOV11BOSNYK-JBROWN7-25', stat: 'points', player: 'Jaylen Brown', strike: 25,
  game_date: '2026-11-11', away: 'BOS', home: 'NYK', yes_bid: 0.55, yes_ask: 0.58, first_yes_ask: null,
  volume: 100, status: 'active', updated_at: '2026-11-11T20:00:00Z',
}
const prop = {
  player_name: 'Jaylen Brown', stat_type: 'points', line: 24.5, direction: 'over',
  confidence_score: 65, confidence_label: 'LOCK', commence_time: '2026-11-12T00:30:00Z',
}

// Chainable stub: every builder method returns itself; range() resolves with the table's result.
function client(results: Record<string, { data: unknown[] | null; error: { message: string } | null }>) {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lt', 'order']) b[m] = () => b
      b.range = () => Promise.resolve(results[table])
      return b
    },
  } as never
}

describe('loadTodayPicks', () => {
  it('still returns exact picks when kalshi_model_rungs fails', async () => {
    const c = client({
      kalshi_markets: { data: [market], error: null },
      props: { data: [prop], error: null },
      prop_alts: { data: [], error: null },
      kalshi_model_rungs: { data: null, error: { message: 'boom' } },
    })
    const r = await loadTodayPicks(c, now)
    expect(r.picks).toHaveLength(1)
    expect(r.stretched).toEqual([])
    expect(r.visible).toHaveLength(1)
    expect(logger.error).toHaveBeenCalled()
  })
})
