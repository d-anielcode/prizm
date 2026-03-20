// /api/gamelogs — Fetch completed NBA box scores from ESPN and upsert to player_game_logs
// Called automatically by cron at 12:10 AM EDT before nightly grading.
// Also callable manually: GET /api/gamelogs?date=2026-03-20

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

type EspnRecord = Record<string, unknown>

async function fetchGameLogsFromESPN(targetDate: string) {
  const espnDate = targetDate.replace(/-/g, '') // YYYYMMDD

  // 1. Get completed games from ESPN scoreboard
  const sbRes = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}`,
    { next: { revalidate: 0 } },
  )
  if (!sbRes.ok) throw new Error(`ESPN scoreboard: ${sbRes.status}`)

  const sbData = await sbRes.json() as EspnRecord
  const events = (sbData.events as EspnRecord[]) ?? []
  const completed = events.filter((e) => {
    const type = ((e.status as EspnRecord)?.type as EspnRecord)
    return type?.completed === true
  })

  if (completed.length === 0) return { rows: [], games: 0, total: events.length }

  const allRows: EspnRecord[] = []

  for (const event of completed) {
    const eventId = event.id as string
    const comp0 = ((event.competitions as EspnRecord[])?.[0]) ?? {}
    const competitors = (comp0.competitors as EspnRecord[]) ?? []

    const homeComp = competitors.find((c) => c.homeAway === 'home') ?? {}
    const awayComp = competitors.find((c) => c.homeAway === 'away') ?? {}
    const homeAbbr = ((homeComp.team as EspnRecord)?.abbreviation as string ?? '').toUpperCase()
    const awayAbbr = ((awayComp.team as EspnRecord)?.abbreviation as string ?? '').toUpperCase()
    const homeScore = parseInt(homeComp.score as string ?? '0') || 0
    const awayScore = parseInt(awayComp.score as string ?? '0') || 0

    // 2. Fetch box score for this game
    const boxRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`,
      { next: { revalidate: 0 } },
    )
    if (!boxRes.ok) continue

    const boxData = await boxRes.json() as EspnRecord
    const teamPlayers = (boxData.boxscore as EspnRecord)?.players as EspnRecord[] ?? []

    for (const teamData of teamPlayers) {
      const teamAbbr = ((teamData.team as EspnRecord)?.abbreviation as string ?? '').toUpperCase()
      const isHome = teamAbbr === homeAbbr
      const opponentAbbr = isHome ? awayAbbr : homeAbbr
      const matchup = isHome
        ? `${teamAbbr} vs. ${opponentAbbr}`
        : `${teamAbbr} @ ${opponentAbbr}`
      const teamWon = isHome ? homeScore > awayScore : awayScore > homeScore

      for (const group of (teamData.statistics as EspnRecord[]) ?? []) {
        const names = (group.names as string[]) ?? []

        // Stat column indices — ESPN NBA box score column order
        const minIdx = names.indexOf('MIN')
        const ptsIdx = names.indexOf('PTS')
        const rebIdx = names.indexOf('REB')
        const astIdx = names.indexOf('AST')
        const stlIdx = names.indexOf('STL')
        const blkIdx = names.indexOf('BLK')
        const fg3Idx = names.indexOf('3PT')

        for (const playerEntry of (group.athletes as EspnRecord[]) ?? []) {
          const athlete = playerEntry.athlete as EspnRecord
          const playerName = athlete?.displayName as string
          if (!playerName) continue

          const stats = (playerEntry.stats as string[]) ?? []
          if (stats.length === 0) continue // DNP — no stats array

          const minutesStr = minIdx >= 0 ? (stats[minIdx] ?? '0') : '0'
          const minutes = parseFloat(minutesStr.split(':')[0]) || 0
          if (minutes < 1) continue // DNP or true garbage time

          const points   = ptsIdx >= 0 ? (parseInt(stats[ptsIdx])  || 0) : 0
          const rebounds = rebIdx >= 0 ? (parseInt(stats[rebIdx])  || 0) : 0
          const assists  = astIdx >= 0 ? (parseInt(stats[astIdx])  || 0) : 0
          const steals   = stlIdx >= 0 ? (parseInt(stats[stlIdx])  || 0) : 0
          const blocks   = blkIdx >= 0 ? (parseInt(stats[blkIdx])  || 0) : 0
          const fg3str   = fg3Idx >= 0 ? (stats[fg3Idx] ?? '0-0') : '0-0'
          const fg3m     = parseInt(fg3str.split('-')[0]) || 0
          const pra      = points + rebounds + assists

          allRows.push({
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
            win:        teamWon,
            fetched_at: new Date().toISOString(),
          })
        }
      }
    }
  }

  return { rows: allRows, games: completed.length, total: events.length }
}

export async function GET(req: Request) {
  const url = new URL(req.url)

  // Default: yesterday in Eastern time (cron runs after midnight)
  let targetDate = url.searchParams.get('date')
  if (!targetDate) {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000)
    targetDate = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  }

  try {
    const { rows, games, total } = await fetchGameLogsFromESPN(targetDate)

    if (rows.length === 0) {
      return NextResponse.json({
        message: total === 0
          ? `No NBA games scheduled for ${targetDate}`
          : games === 0
            ? `No completed games yet for ${targetDate} (${total} scheduled)`
            : `Box scores not yet available for ${targetDate}`,
        date: targetDate,
        games,
        scheduled: total,
      })
    }

    // Upsert to player_game_logs (requires UNIQUE constraint on player_name, game_date)
    const BATCH = 200
    let upserted = 0
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const { error } = await supabase
        .from('player_game_logs')
        .upsert(slice, { onConflict: 'player_name,game_date' })
      if (!error) upserted += slice.length
      else console.error('[/api/gamelogs] upsert error:', error.message)
    }

    return NextResponse.json({
      message: `Fetched ${games} game(s) — upserted ${upserted} player rows for ${targetDate}`,
      date: targetDate,
      games,
      players: upserted,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/gamelogs]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
