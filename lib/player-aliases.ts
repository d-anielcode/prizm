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
  // GG Jackson II — props uses "GG Jackson II", no further alias needed

  // Initials: ESPN omits periods — only alias if The Odds API actually includes them
  // (Verified: CJ McCollum — props uses "CJ McCollum", no alias needed)
  'AJ Green':           'A.J. Green',
  'RJ Barrett':         'R.J. Barrett',

  // Nickname vs full name
  'Bub Carrington':     'Carlton Carrington',

  // Suffix: The Odds API omits "II" suffix
  'Ronald Holland II':  'Ron Holland',

  // Unicode: ESPN uses ASCII, The Odds API uses accented characters
  'Luka Doncic':        'Luka Dončić',
  'Alperen Sengun':     'Alperen Sengün',
  'Nikola Jokic':       'Nikola Jokić',
  'Bogdan Bogdanovic':  'Bogdan Bogdanović',
  'Bojan Bogdanovic':   'Bojan Bogdanović',
  'Kristaps Porzingis': 'Kristaps Porziņģis',
  'Dario Saric':        'Dario Šarić',
  'Vlatko Cancar':      'Vlatko Čančar',

  // Jr. suffix: ESPN uses period, The Odds API omits it
  'Michael Porter Jr.': 'Michael Porter Jr',
  'Jabari Smith Jr.':   'Jabari Smith Jr.',  // props keeps the period
  'Craig Porter Jr.':   'Craig Porter Jr',
  'Paul Reed Jr.':      'Paul Reed',
  'Paul Reed':          'Paul Reed',
  'Gary Trent Jr.':     'Gary Trent Jr',
  'Tim Hardaway Jr.':   'Tim Hardaway Jr',
  'Scotty Pippen Jr.':  'Scotty Pippen Jr',
  'Kelly Oubre Jr.':    'Kelly Oubre Jr',
  'Wendell Carter Jr.': 'Wendell Carter Jr',
  'Derrick Jones Jr.':  'Derrick Jones Jr.',  // props uses "Derrick Jones Jr."
  'Isaiah Stewart':     'Isaiah Stewart II',

  // Jr. with period: ESPN includes period, The Odds API keeps period — no transform needed
  // (Jaime Jaquez Jr. removed: ESPN and odds-api both use "Jaime Jaquez Jr." exactly)
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
