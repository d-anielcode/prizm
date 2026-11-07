import { describe, it, expect } from 'vitest'
import { modeOf, tabHref, counterpartPath } from '@/lib/mode'

describe('mode', () => {
  it('detects markets mode by prefix', () => {
    expect(modeOf('/markets')).toBe('markets')
    expect(modeOf('/markets/props')).toBe('markets')
    expect(modeOf('/marketsx')).toBe('sportsbook')
    expect(modeOf('/props')).toBe('sportsbook')
  })
  it('prefixes tab hrefs in markets mode', () => {
    expect(tabHref('/', 'markets')).toBe('/markets')
    expect(tabHref('/props', 'markets')).toBe('/markets/props')
    expect(tabHref('/props', 'sportsbook')).toBe('/props')
  })
  it('maps a page to its counterpart in the other mode', () => {
    expect(counterpartPath('/props')).toBe('/markets/props')
    expect(counterpartPath('/')).toBe('/markets')
    expect(counterpartPath('/markets/edge')).toBe('/edge')
    expect(counterpartPath('/markets')).toBe('/')
    expect(counterpartPath('/player/LeBron%20James')).toBe('/markets')
    expect(counterpartPath('/status')).toBe('/markets')
  })
})
