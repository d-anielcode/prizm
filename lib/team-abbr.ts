/** Full NBA team name → ESPN 3-letter abbreviation */
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

/** Reverse: ESPN 3-letter abbreviation → full team name */
export const ABBR_TO_TEAM: Record<string, string> = Object.fromEntries(
  Object.entries(TEAM_ABBR).map(([name, abbr]) => [abbr, name]),
)
