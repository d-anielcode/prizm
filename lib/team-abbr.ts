/** Full NBA team name → canonical NBA abbreviation (the codes used across Prizm's tables). */
export const TEAM_ABBR: Record<string, string> = {
  'Atlanta Hawks':          'ATL',
  'Boston Celtics':         'BOS',
  'Brooklyn Nets':          'BKN',
  'Charlotte Hornets':      'CHA',
  'Chicago Bulls':          'CHI',
  'Cleveland Cavaliers':    'CLE',
  'Dallas Mavericks':       'DAL',
  'Denver Nuggets':         'DEN',
  'Detroit Pistons':        'DET',
  'Golden State Warriors':  'GSW',
  'Houston Rockets':        'HOU',
  'Indiana Pacers':         'IND',
  'Los Angeles Clippers':   'LAC',
  'Los Angeles Lakers':     'LAL',
  'Memphis Grizzlies':      'MEM',
  'Miami Heat':             'MIA',
  'Milwaukee Bucks':        'MIL',
  'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans':   'NOP',
  'New York Knicks':        'NYK',
  'Oklahoma City Thunder':  'OKC',
  'Orlando Magic':          'ORL',
  'Philadelphia 76ers':     'PHI',
  'Phoenix Suns':           'PHX',
  'Portland Trail Blazers': 'POR',
  'Sacramento Kings':       'SAC',
  'San Antonio Spurs':      'SAS',
  'Toronto Raptors':        'TOR',
  'Utah Jazz':              'UTA',
  'Washington Wizards':     'WAS',
}

/** Reverse: canonical abbreviation → full team name */
export const ABBR_TO_TEAM: Record<string, string> = Object.fromEntries(
  Object.entries(TEAM_ABBR).map(([name, abbr]) => [abbr, name]),
)

/** ESPN (game logs, scoreboards, rosters) uses a few codes that differ from the
 *  canonical ones; NJ covers historical New Jersey Nets rows in backtests. */
const ESPN_TO_CANONICAL: Record<string, string> = {
  GS: 'GSW', NO: 'NOP', NY: 'NYK', SA: 'SAS', UTAH: 'UTA', WSH: 'WAS', NJ: 'NJN',
}

/** Any team code (ESPN or canonical) → canonical TEAM_ABBR code. Compare team codes
 *  from different sources only after passing both through this. */
export function normalizeTeamAbbr(code: string | null | undefined): string | null {
  const c = (code ?? '').trim().toUpperCase()
  if (!c) return null
  return ESPN_TO_CANONICAL[c] ?? c
}
