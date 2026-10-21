import { describe, it, expect } from 'vitest'
import { resolvePlayerTeam, fetchEspnRosters } from '../rosters'

const roster = new Map([['giannis antetokounmpo', 'MIA'], ['jalen brunson', 'NYK']])

describe('resolvePlayerTeam', () => {
  // Regression: team came from the latest game log, so offseason moves (Giannis
  // MIL -> MIA) left the player matching neither team and lost all matchup context.
  it('uses the current roster over a stale game log', () => {
    expect(resolvePlayerTeam('Giannis Antetokounmpo', 'MIL vs. BOS', 'MIA', 'MIN', roster))
      .toEqual({ isHome: true, opponentAbbr: 'MIN', playerTeamAbbr: 'MIA', source: 'roster' })
  })

  it('normalizes ESPN log codes when falling back to logs', () => {
    expect(resolvePlayerTeam('Stephen Curry', 'GS @ LAL', 'LAL', 'GSW', new Map()))
      .toEqual({ isHome: false, opponentAbbr: 'LAL', playerTeamAbbr: 'GSW', source: 'logs' })
  })

  it('falls back to logs when the roster team is not in this game', () => {
    const stale = new Map([['jalen brunson', 'BOS']])
    expect(resolvePlayerTeam('Jalen Brunson', 'NY vs. PHI', 'NYK', 'CHA', stale).source).toBe('logs')
  })

  it('matches name variants via normalization', () => {
    expect(resolvePlayerTeam('Jalen Brunson.', null, 'NYK', 'PHI', roster).playerTeamAbbr).toBe('NYK')
  })

  it('returns no context when neither source matches tonight', () => {
    expect(resolvePlayerTeam('Nobody Here', 'MIL @ BOS', 'MIA', 'MIN', roster))
      .toEqual({ isHome: null, opponentAbbr: null, playerTeamAbbr: 'MIL', source: null })
  })
})

describe('fetchEspnRosters', () => {
  it('builds name -> canonical team, skipping teams whose roster call fails', async () => {
    const fake = async (url: string) => {
      const body = url.endsWith('/teams')
        ? { sports: [{ leagues: [{ teams: [{ team: { id: '9', abbreviation: 'GS' } }, { team: { id: '1', abbreviation: 'ATL' } }] }] }] }
        : url.includes('/teams/9/') ? { athletes: [{ displayName: 'Stephen Curry' }] } : null
      return { ok: body !== null, json: async () => body } as Response
    }
    const m = await fetchEspnRosters(fake as unknown as typeof fetch)
    expect([...m.entries()]).toEqual([['stephen curry', 'GSW']])
  })

  it('returns an empty map when ESPN is unreachable', async () => {
    const down = async () => { throw new Error('offline') }
    expect((await fetchEspnRosters(down as unknown as typeof fetch)).size).toBe(0)
  })
})

describe('resolvePlayerTeam suffixes', () => {
  // Regression: props said "Jaime Jaquez" while ESPN lists "Jaime Jaquez Jr.".
  it('matches with or without Jr./Sr./II/III', () => {
    const r = new Map([['jaime jaquez jr', 'MIL'], ['gary payton', 'GSW']])
    expect(resolvePlayerTeam('Jaime Jaquez', null, 'WAS', 'MIL', r).playerTeamAbbr).toBe('MIL')
    expect(resolvePlayerTeam('Gary Payton II', null, 'GSW', 'LAL', r).playerTeamAbbr).toBe('GSW')
  })
})
