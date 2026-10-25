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
  'Alex Sarr':          'Alexandre Sarr',

  // Suffix: The Odds API omits "II" suffix
  'Ronald Holland II':  'Ron Holland',

  // Unicode: ESPN uses ASCII, The Odds API uses accented characters
  'Moussa Diabate':     'Moussa Diabaté',
  'Nolan Traore':       'Nolan Traoré',
  'Luka Doncic':        'Luka Dončić',
  'Alperen Sengun':     'Alperen Sengün',
  'Nikola Jokic':       'Nikola Jokić',
  'Bogdan Bogdanovic':  'Bogdan Bogdanović',
  'Bojan Bogdanovic':   'Bojan Bogdanović',
  // Temporary reverse alias to fix wrongly-renamed rows — remove after running fix-names once
  'Kristaps Porziņģis': 'Kristaps Porzingis',
  'Dario Saric':        'Dario Šarić',
  'Vlatko Cancar':      'Vlatko Čančar',

  // Jr. suffix: ESPN uses period, The Odds API omits it
  // IMPORTANT: Only add here if CONFIRMED The Odds API omits the period.
  // If both ESPN and Odds API use the period, DO NOT add an alias — it will break lookups.
  'Michael Porter Jr.': 'Michael Porter Jr',
  'Jabari Smith Jr.':   'Jabari Smith Jr.',  // props keeps the period
  'Craig Porter Jr.':   'Craig Porter Jr',
  'Paul Reed Jr.':      'Paul Reed',
  'Paul Reed':          'Paul Reed',
  'Gary Trent Jr.':     'Gary Trent Jr',
  // Temporary reverse alias to fix wrongly-stored rows — remove after running fix-names once
  'Tim Hardaway Jr':    'Tim Hardaway Jr.',  // both ESPN and Odds API use the period
  'Scotty Pippen Jr.':  'Scotty Pippen Jr',
  'Kelly Oubre Jr.':    'Kelly Oubre Jr',
  // 'Wendell Carter Jr.': REMOVED — both ESPN and Odds API use "Wendell Carter Jr." (with period)
  'Derrick Jones Jr.':  'Derrick Jones Jr.',  // props uses "Derrick Jones Jr."
  'Isaiah Stewart':     'Isaiah Stewart II',

  // Jr. with period: ESPN includes period, The Odds API keeps period — no transform needed
  // Confirmed: Wendell Carter Jr., Tim Hardaway Jr., Jaime Jaquez Jr. — both systems use exact same name
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

// Read-only equivalences for log lookups (not applied when writing names, unlike
// ESPN_TO_ODDS): spellings seen in player_game_logs / props that the rules in
// playerNameVariants can't derive (accents added, capitalization).
const LOOKUP_EQUIVALENTS: string[][] = [
  ['Nikola Vucevic', 'Nikola Vučević'],
  ['Dennis Schroder', 'Dennis Schröder'],
  ['Jake LaRavia', 'Jake Laravia'],
]

/**
 * Every spelling a player's game logs may be stored under: the name itself, its
 * odds-api/ESPN aliases, accent-stripped forms, "Jr"/"Jr." and "CJ"/"C.J." forms.
 * Writers disagree ("Nikola Jokic" vs "Nikola Jokić", "RJ Barrett" vs "R.J. Barrett"),
 * so query logs with all of these and match rows back with normalizePlayerName.
 */
export function playerNameVariants(name: string): string[] {
  const strip = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '')
  const canon = normalizeEspnName(name)
  const out = new Set([name, canon, ...getEspnVariants(name), ...getEspnVariants(canon)])
  for (const group of LOOKUP_EQUIVALENTS) if (group.some((g) => out.has(g))) group.forEach((g) => out.add(g))
  for (const n of [...out]) {
    out.add(strip(n))
    // Suffix with and without period: "Jabari Smith Jr" / "Jabari Smith Jr."
    const suffix = n.match(/^(.*\s(?:Jr|Sr))\.?$/)
    if (suffix) { out.add(suffix[1]); out.add(`${suffix[1]}.`) }
    // Two-letter initials with and without periods: "CJ McCollum" / "C.J. McCollum"
    const initials = n.match(/^([A-Z])\.?([A-Z])\.?(\s.*)$/)
    if (initials) { out.add(`${initials[1]}${initials[2]}${initials[3]}`); out.add(`${initials[1]}.${initials[2]}.${initials[3]}`) }
  }
  return [...out]
}
