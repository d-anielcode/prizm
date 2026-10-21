// Current NBA rosters (ESPN) and per-player team resolution.
//
// A player's team used to come from their latest game log, which goes stale after
// any trade or signing (and in the offseason, for everyone who moved). ESPN's team
// rosters are current; the game log is only a fallback for when ESPN is unreachable
// or doesn't list the player.

import { normalizePlayerName } from '@/lib/lineups'
import { normalizeTeamAbbr } from '@/lib/team-abbr'

const ESPN_TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams'

/** normalizePlayerName(name) -> canonical team code, from ESPN's 30 team rosters.
 *  Never throws: a failed team call is skipped, and an unreachable ESPN gives an
 *  empty map (callers then fall back to game logs). */
export async function fetchEspnRosters(fetchFn: typeof fetch = fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const res = await fetchFn(ESPN_TEAMS, { cache: 'no-store' })
    if (!res.ok) return out
    const data = await res.json() as {
      sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: { id?: string; abbreviation?: string } }> }> }>
    }
    const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? []
    await Promise.all(teams.map(async ({ team }) => {
      const code = normalizeTeamAbbr(team?.abbreviation)
      if (!team?.id || !code) return
      try {
        const r = await fetchFn(`${ESPN_TEAMS}/${team.id}/roster`, { cache: 'no-store' })
        if (!r.ok) return
        const roster = await r.json() as { athletes?: Array<{ displayName?: string }> }
        for (const a of roster.athletes ?? []) {
          if (a.displayName) out.set(normalizePlayerName(a.displayName), code)
        }
      } catch {
        // one team's roster missing -> its players fall back to game logs
      }
    }))
  } catch {
    // ESPN unreachable -> empty map
  }
  return out
}

const SUFFIX_RE = /\s+(jr|sr|ii|iii|iv)$/

/** Roster lookup that tolerates a missing or extra suffix ("Jaime Jaquez" vs
 *  ESPN's "Jaime Jaquez Jr.", "Gary Payton II" vs "Gary Payton"). */
function lookupRoster(roster: Map<string, string>, playerName: string): string | null {
  const name = normalizePlayerName(playerName)
  const direct = roster.get(name)
  if (direct) return direct
  const bare = name.replace(SUFFIX_RE, '')
  if (bare !== name && roster.get(bare)) return roster.get(bare)!
  for (const sfx of ['jr', 'sr', 'ii', 'iii', 'iv']) {
    const t = roster.get(`${bare} ${sfx}`)
    if (t) return t
  }
  return null
}

export interface PlayerTeamContext {
  isHome: boolean | null
  opponentAbbr: string | null
  playerTeamAbbr: string | null
  source: 'roster' | 'logs' | null
}

/** Which side of tonight's game a player is on. Roster team first (if it's one of
 *  tonight's two teams), then the latest game log's team; otherwise no context. */
export function resolvePlayerTeam(
  playerName: string,
  latestLogMatchup: string | null | undefined,
  homeAbbr: string | null,
  awayAbbr: string | null,
  roster: Map<string, string>,
): PlayerTeamContext {
  const home = normalizeTeamAbbr(homeAbbr)
  const away = normalizeTeamAbbr(awayAbbr)
  const fromRoster = lookupRoster(roster, playerName)
  const fromLogs = normalizeTeamAbbr((latestLogMatchup ?? '').split(/\s+vs\.\s+|\s+@\s+/)[0])

  const candidates: Array<[string | null, 'roster' | 'logs']> = [[fromRoster, 'roster'], [fromLogs, 'logs']]
  for (const [team, source] of candidates) {
    if (team && team === home) return { isHome: true, opponentAbbr: away, playerTeamAbbr: team, source }
    if (team && team === away) return { isHome: false, opponentAbbr: home, playerTeamAbbr: team, source }
  }
  return { isHome: null, opponentAbbr: null, playerTeamAbbr: fromRoster ?? fromLogs, source: null }
}
