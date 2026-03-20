// Shared ESPN box-score fetch logic used by both /api/gamelogs and /api/gamelogs/backfill

import { normalizeEspnName } from './player-aliases'

type EspnRecord = Record<string, unknown>

export interface GameLogRow {
  nba_id:      string | null
  player_name: string
  game_date:   string
  matchup:     string
  is_home:     boolean
  points:      number
  rebounds:    number
  assists:     number
  steals:      number
  blocks:      number
  fg3m:        number
  minutes:     number
  pra:         number
  win:         boolean
  fetched_at:  string
}

export async function fetchGameLogsFromESPN(
  targetDate: string,
): Promise<{ rows: GameLogRow[]; games: number; total: number }> {
  const espnDate = targetDate.replace(/-/g, '') // YYYYMMDD

  // 1. Get completed games from ESPN scoreboard
  const sbRes = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}`,
    { cache: 'no-store' },
  )
  if (!sbRes.ok) throw new Error(`ESPN scoreboard ${sbRes.status} for ${targetDate}`)

  const sbData = (await sbRes.json()) as EspnRecord
  const events = (sbData.events as EspnRecord[]) ?? []
  const completed = events.filter((e) => {
    const type = ((e.status as EspnRecord)?.type as EspnRecord)
    return type?.completed === true
  })

  if (completed.length === 0) return { rows: [], games: 0, total: events.length }

  const allRows: GameLogRow[] = []
  const now = new Date().toISOString()

  for (const event of completed) {
    const eventId = event.id as string
    const comp0 = ((event.competitions as EspnRecord[])?.[0]) ?? {}
    const competitors = (comp0.competitors as EspnRecord[]) ?? []

    const homeComp = competitors.find((c) => c.homeAway === 'home') ?? {}
    const awayComp = competitors.find((c) => c.homeAway === 'away') ?? {}
    const homeAbbr = ((homeComp.team as EspnRecord)?.abbreviation as string ?? '').toUpperCase()
    const awayAbbr = ((awayComp.team as EspnRecord)?.abbreviation as string ?? '').toUpperCase()
    const homeScore = parseInt((homeComp.score as string) ?? '0') || 0
    const awayScore = parseInt((awayComp.score as string) ?? '0') || 0

    // 2. Fetch box score for this game
    const boxRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`,
      { cache: 'no-store' },
    )
    if (!boxRes.ok) continue

    const boxData = (await boxRes.json()) as EspnRecord
    const teamPlayers = ((boxData.boxscore as EspnRecord)?.players as EspnRecord[]) ?? []

    for (const teamData of teamPlayers) {
      const teamAbbr = ((teamData.team as EspnRecord)?.abbreviation as string ?? '').toUpperCase()
      const isHome = teamAbbr === homeAbbr
      const opponentAbbr = isHome ? awayAbbr : homeAbbr
      const matchup = isHome ? `${teamAbbr} vs. ${opponentAbbr}` : `${teamAbbr} @ ${opponentAbbr}`
      const teamWon = isHome ? homeScore > awayScore : awayScore > homeScore

      for (const group of (teamData.statistics as EspnRecord[]) ?? []) {
        const names = (group.names as string[]) ?? []

        // ESPN NBA box score column indices
        const minIdx = names.indexOf('MIN')
        const ptsIdx = names.indexOf('PTS')
        const rebIdx = names.indexOf('REB')
        const astIdx = names.indexOf('AST')
        const stlIdx = names.indexOf('STL')
        const blkIdx = names.indexOf('BLK')
        const fg3Idx = names.indexOf('3PT')

        for (const playerEntry of (group.athletes as EspnRecord[]) ?? []) {
          const athlete = playerEntry.athlete as EspnRecord
          const rawName = athlete?.displayName as string
          if (!rawName) continue
          const playerName = normalizeEspnName(rawName)

          const stats = (playerEntry.stats as string[]) ?? []
          if (stats.length === 0) continue // DNP

          const minutesStr = minIdx >= 0 ? (stats[minIdx] ?? '0') : '0'
          const minutes = parseFloat(minutesStr.split(':')[0]) || 0
          if (minutes < 1) continue // DNP or garbage time

          const points   = ptsIdx >= 0 ? parseInt(stats[ptsIdx]) || 0 : 0
          const rebounds = rebIdx >= 0 ? parseInt(stats[rebIdx]) || 0 : 0
          const assists  = astIdx >= 0 ? parseInt(stats[astIdx]) || 0 : 0
          const steals   = stlIdx >= 0 ? parseInt(stats[stlIdx]) || 0 : 0
          const blocks   = blkIdx >= 0 ? parseInt(stats[blkIdx]) || 0 : 0
          const fg3str   = fg3Idx >= 0 ? (stats[fg3Idx] ?? '0-0') : '0-0'
          const fg3m     = parseInt(fg3str.split('-')[0]) || 0
          const pra      = points + rebounds + assists

          allRows.push({
            nba_id:      (athlete.id as string) ?? null,
            player_name: playerName,
            game_date:   targetDate,
            matchup,
            is_home:     isHome,
            points,
            rebounds,
            assists,
            steals,
            blocks,
            fg3m,
            minutes,
            pra,
            win:         teamWon,
            fetched_at:  now,
          })
        }
      }
    }
  }

  return { rows: allRows, games: completed.length, total: events.length }
}

/** Generate all calendar dates between start (inclusive) and end (inclusive) */
export function dateRange(start: string, end: string): string[] {
  const dates: string[] = []
  const cur = new Date(start + 'T12:00:00Z')
  const last = new Date(end + 'T12:00:00Z')
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return dates
}
