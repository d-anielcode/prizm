import { describe, it, expect } from 'vitest'
import { playerNameVariants } from '../player-aliases'

describe('playerNameVariants', () => {
  // Regression: enrich matched logs by exact prop spelling, so a "Nikola Jokic"
  // prop missed every game stored as "Nikola Jokić" (and vice versa).
  it('covers accented and plain spellings from either side', () => {
    expect(playerNameVariants('Nikola Jokic')).toEqual(expect.arrayContaining(['Nikola Jokic', 'Nikola Jokić']))
    expect(playerNameVariants('Nikola Jokić')).toEqual(expect.arrayContaining(['Nikola Jokic', 'Nikola Jokić']))
  })

  it('covers initials with and without periods', () => {
    expect(playerNameVariants('RJ Barrett')).toEqual(expect.arrayContaining(['RJ Barrett', 'R.J. Barrett']))
    expect(playerNameVariants('R.J. Barrett')).toEqual(expect.arrayContaining(['RJ Barrett', 'R.J. Barrett']))
  })

  it('strips accents for names missing from the alias table', () => {
    expect(playerNameVariants('Dennis Schröder')).toContain('Dennis Schroder')
  })
})

describe('playerNameVariants suffix and initials forms', () => {
  it('toggles the Jr period', () => {
    expect(playerNameVariants('Jaime Jaquez Jr')).toContain('Jaime Jaquez Jr.')
    expect(playerNameVariants('Jaime Jaquez Jr.')).toContain('Jaime Jaquez Jr')
  })

  it('toggles periods in two-letter initials', () => {
    expect(playerNameVariants('CJ McCollum')).toContain('C.J. McCollum')
    expect(playerNameVariants('C.J. McCollum')).toContain('CJ McCollum')
  })

  it('adds accents for listed names', () => {
    expect(playerNameVariants('Dennis Schroder')).toContain('Dennis Schröder')
  })
})
