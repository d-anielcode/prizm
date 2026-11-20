// Sportsbook mode lives at the existing routes; Prediction Markets mode under /markets.
export type Mode = 'sportsbook' | 'markets'

export const MARKETS_PREFIX = '/markets'
/** Tabs that exist in both modes (sportsbook paths). */
export const SHARED_TABS = ['/', '/feed', '/edge', '/trends', '/props', '/performance'] as const

export function modeOf(pathname: string): Mode {
  return pathname === MARKETS_PREFIX || pathname.startsWith(`${MARKETS_PREFIX}/`) ? 'markets' : 'sportsbook'
}

/** A sportsbook tab href as it appears in `mode`. */
export function tabHref(href: string, mode: Mode): string {
  if (mode === 'sportsbook') return href
  return href === '/' ? MARKETS_PREFIX : `${MARKETS_PREFIX}${href}`
}

/** Same tab in the other mode; pages without a counterpart go to the other mode's home. */
export function counterpartPath(pathname: string): string {
  if (modeOf(pathname) === 'markets') {
    const rest = pathname.slice(MARKETS_PREFIX.length) || '/'
    return (SHARED_TABS as readonly string[]).includes(rest) ? rest : '/'
  }
  return (SHARED_TABS as readonly string[]).includes(pathname) ? tabHref(pathname, 'markets') : MARKETS_PREFIX
}
