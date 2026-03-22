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
  'Moe Wagner':         'Moritz Wagner',
  'Rob Williams':       'Robert Williams III',
  'Marcus Morris Sr.':  'Marcus Morris',
  'GG Jackson':         'GG Jackson II',
  'GG Jackson II':      'G.G. Jackson',

  // Initials: ESPN omits periods, The Odds API includes them
  'AJ Green':           'A.J. Green',
  'CJ McCollum':        'C.J. McCollum',
  'RJ Barrett':         'R.J. Barrett',

  // Nickname vs full name
  'Bub Carrington':     'Carlton Carrington',

  // Suffix: The Odds API omits "II" suffix
  'Ronald Holland II':  'Ron Holland',

  // Jr. suffix: ESPN uses period, The Odds API omits it
  'Michael Porter Jr.': 'Michael Porter Jr',
  'Jabari Smith Jr.':   'Jabari Smith Jr',
  'Craig Porter Jr.':   'Craig Porter Jr',
  'Paul Reed Jr.':      'Paul Reed Jr',
  'Paul Reed':          'Paul Reed Jr',
  'Jaime Jaquez Jr.':   'Jaime Jaquez Jr',
  'Gary Trent Jr.':     'Gary Trent Jr',
  'Tim Hardaway Jr.':   'Tim Hardaway Jr',
  'Scotty Pippen Jr.':  'Scotty Pippen Jr',
  'Kelly Oubre Jr.':    'Kelly Oubre Jr',
  'Wendell Carter Jr.': 'Wendell Carter Jr',
  'Derrick Jones Jr.':  'Derrick Jones',
  'Isaiah Stewart':     'Isaiah Stewart II',
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
