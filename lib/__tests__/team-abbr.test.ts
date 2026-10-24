import { describe, it, expect } from 'vitest'
import { TEAM_ABBR, ABBR_TO_TEAM, normalizeTeamAbbr } from '../team-abbr'

// Every abbreviation ESPN's /teams endpoint returned on 2026-10-21.
const ESPN_CODES = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND',
  'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC',
  'SA', 'TOR', 'UTAH', 'WSH']

describe('normalizeTeamAbbr', () => {
  // Regression: game logs and ESPN scoreboards use GS/NY/SA/NO/UTAH/WSH while
  // TEAM_ABBR uses GSW/NYK/SAS/NOP/UTA/WAS, so players on those six teams never
  // matched tonight's game and lost all opponent/home-away/spread/B2B context.
  it('maps every ESPN code onto a TEAM_ABBR code', () => {
    const nba = new Set(Object.values(TEAM_ABBR))
    for (const c of ESPN_CODES) expect(nba.has(normalizeTeamAbbr(c)!)).toBe(true)
  })

  it('leaves NBA codes unchanged', () => {
    for (const c of Object.values(TEAM_ABBR)) expect(normalizeTeamAbbr(c)).toBe(c)
  })

  it('trims, upper-cases and handles empty input', () => {
    expect(normalizeTeamAbbr(' gs ')).toBe('GSW')
    expect(normalizeTeamAbbr('')).toBeNull()
    expect(normalizeTeamAbbr(undefined)).toBeNull()
  })
})

describe('TEAM_ABBR aliases', () => {
  // Regression: the odds feed names the Clippers "LA Clippers"; it wasn't mapped,
  // so every Clippers game lost matchup context and its spread.
  it('maps the odds feed name for the Clippers', () => {
    expect(TEAM_ABBR['LA Clippers']).toBe('LAC')
  })

  it('keeps the full name in the reverse map', () => {
    expect(ABBR_TO_TEAM['LAC']).toBe('Los Angeles Clippers')
  })
})
