/**
 * Maps ESPN displayName → canonical odds-api name.
 * Used when ingesting game logs so player_game_logs stores names
 * that match what the props table contains.
 *
 * IMPORTANT: Only add entries where the name is CONFIRMED different between
 * ESPN and the odds-api. Both systems generally use the same format (no periods
 * in initials like CJ, OG, RJ, PJ, etc.). Wrong aliases will BREAK working players.
 *
 * Add entries whenever a player has no graph on their page.
 */
export const ESPN_TO_ODDS: Record<string, string> = {
  // Confirmed: ESPN uses nickname, odds-api uses full name
  'Nic Claxton':        'Nicolas Claxton',
  'Mo Bamba':           'Mohamed Bamba',
  'Mo Wagner':          'Moritz Wagner',
  'Rob Williams':       'Robert Williams III',
  'Marcus Morris Sr.':  'Marcus Morris',
  'GG Jackson':         'GG Jackson II',
}

/** Normalize an ESPN displayName to match how it appears in the props/odds tables. */
export function normalizeEspnName(espnName: string): string {
  return ESPN_TO_ODDS[espnName] ?? espnName
}

/**
 * Given an odds-api player name, return all possible ESPN variants to search for.
 * Useful for the player page when the odds-api name differs from what's in game logs.
 */
export function getEspnVariants(oddsName: string): string[] {
  // Direct reverse lookup — find ESPN names that map to this odds-api name
  const espnVariants = Object.entries(ESPN_TO_ODDS)
    .filter(([, v]) => v === oddsName)
    .map(([k]) => k)
  // Return unique values (odds name first, then any ESPN variants)
  return [...new Set([oddsName, ...espnVariants])]
}
