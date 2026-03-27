// /api/gamelogs/player — Backfill full-season game log for a single player via ESPN athlete API
//
// One ESPN call returns the entire season (~70+ games), far faster than date-by-date scanning.
//
// GET ?name=Wendell+Carter+Jr   — player name as stored in props (Odds API format)
// GET ?espnId=4277847           — optional: provide ESPN ID directly to skip search

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { GameLogRow } from '@/lib/espn-gamelogs'

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!,
    { auth: { persistSession: false } },
  )
}

export const maxDuration = 60

async function searchEspnPlayer(name: string): Promise<{ id: string; displayName: string } | null> {
  const url = `https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(name)}&limit=5&lang=en&region=us&type=player`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) return null
  const data = (await res.json()) as Record<string, unknown>
  const results = (data.results as Record<string, unknown>[])?.[0]
  const contents = (results?.contents as Record<string, unknown>[]) ?? []
  // Find first NBA player (league id 46)
  const nbaPlayer = contents.find(
    (r) => r.description === 'NBA' && typeof r.uid === 'string' && r.uid.includes('l:46'),
  )
  if (!nbaPlayer) return null
  const idMatch = (nbaPlayer.uid as string).match(/a:(\d+)/)
  if (!idMatch) return null
  return { id: idMatch[1], displayName: nbaPlayer.displayName as string }
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const playerName = url.searchParams.get('name')
  let espnId = url.searchParams.get('espnId')

  if (!playerName) {
    return NextResponse.json({ error: 'name param required (Odds API format)' }, { status: 400 })
  }

  // Look up ESPN ID if not provided
  if (!espnId) {
    const found = await searchEspnPlayer(playerName)
    if (!found) {
      return NextResponse.json({ error: `Player not found on ESPN: ${playerName}` }, { status: 404 })
    }
    espnId = found.id
  }

  // Fetch full-season gamelog from ESPN athlete API
  const logRes = await fetch(
    `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}/gamelog`,
    { cache: 'no-store' },
  )
  if (!logRes.ok) {
    return NextResponse.json({ error: `ESPN gamelog ${logRes.status} for id ${espnId}` }, { status: 502 })
  }

  const logData = (await logRes.json()) as Record<string, unknown>
  const labels = (logData.labels as string[]) ?? []
  const eventsMap = (logData.events as Record<string, Record<string, unknown>>) ?? {}
  const seasonTypes = (logData.seasonTypes as Record<string, unknown>[]) ?? []

  const minIdx = labels.indexOf('MIN')
  const ptsIdx = labels.indexOf('PTS')
  const rebIdx = labels.indexOf('REB')
  const astIdx = labels.indexOf('AST')
  const blkIdx = labels.indexOf('BLK')
  const stlIdx = labels.indexOf('STL')
  const fg3Idx = labels.indexOf('3PT')

  const rows: GameLogRow[] = []
  const now = new Date().toISOString()

  for (const seasonType of seasonTypes) {
    for (const category of (seasonType.categories as Record<string, unknown>[]) ?? []) {
      for (const ev of (category.events as Record<string, unknown>[]) ?? []) {
        const eventId = ev.eventId as string
        const stats = ev.stats as string[]
        if (!stats || stats.length === 0) continue

        // Skip DNP (minutes = 0 or missing)
        const minutesStr = minIdx >= 0 ? (stats[minIdx] ?? '0') : '0'
        const minutes = parseFloat(minutesStr) || 0
        if (minutes < 1) continue

        const meta = eventsMap[eventId]
        if (!meta) continue

        const gameDate = (meta.gameDate as string).slice(0, 10)
        // Only current season
        if (gameDate < '2025-10-22') continue

        const isHome = (meta.atVs as string) !== '@'
        const playerTeam = (meta.team as Record<string, string>)?.abbreviation ?? ''
        const oppTeam = (meta.opponent as Record<string, string>)?.abbreviation ?? ''
        const matchup = isHome ? `${playerTeam} vs. ${oppTeam}` : `${playerTeam} @ ${oppTeam}`
        const win = (meta.gameResult as string) === 'W'

        const points   = ptsIdx >= 0 ? parseInt(stats[ptsIdx]) || 0 : 0
        const rebounds = rebIdx >= 0 ? parseInt(stats[rebIdx]) || 0 : 0
        const assists  = astIdx >= 0 ? parseInt(stats[astIdx]) || 0 : 0
        const steals   = stlIdx >= 0 ? parseInt(stats[stlIdx]) || 0 : 0
        const blocks   = blkIdx >= 0 ? parseInt(stats[blkIdx]) || 0 : 0
        const fg3str   = fg3Idx >= 0 ? (stats[fg3Idx] ?? '0-0') : '0-0'
        const fg3m     = parseInt(fg3str.split('-')[0]) || 0
        const pra      = points + rebounds + assists

        rows.push({
          nba_id:      espnId,
          player_name: playerName,
          game_date:   gameDate,
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
          win,
          fetched_at:  now,
        })
      }
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({
      message: 'No game log entries found for this player',
      playerName,
      espnId,
      inserted: 0,
    })
  }

  const db = getDb()

  // Check existing rows by nba_id — catches rows stored under a different name variant
  const { data: existing } = await db
    .from('player_game_logs')
    .select('game_date, player_name')
    .eq('nba_id', espnId)

  const existingByDate = new Map((existing ?? []).map((r) => [r.game_date as string, r.player_name as string]))

  // Rename any rows stored under the wrong player_name (ESPN vs Odds API name mismatch)
  const wrongNameDates = [...existingByDate.entries()]
    .filter(([, name]) => name !== playerName)
    .map(([date]) => date)

  let renamed = 0
  const RENAME_BATCH = 100
  for (let i = 0; i < wrongNameDates.length; i += RENAME_BATCH) {
    const { error } = await db
      .from('player_game_logs')
      .update({ player_name: playerName })
      .eq('nba_id', espnId)
      .in('game_date', wrongNameDates.slice(i, i + RENAME_BATCH))
    if (!error) renamed += Math.min(RENAME_BATCH, wrongNameDates.length - i)
    else console.error('[gamelogs/player] rename error:', error.message)
  }

  // Only insert dates that don't exist at all for this nba_id
  const newRows = rows.filter((r) => !existingByDate.has(r.game_date))

  const BATCH = 200
  let inserted = 0
  for (let i = 0; i < newRows.length; i += BATCH) {
    const { error } = await db.from('player_game_logs').insert(newRows.slice(i, i + BATCH))
    if (!error) inserted += Math.min(BATCH, newRows.length - i)
    else console.error('[gamelogs/player] insert error:', error.message)
  }

  console.log(`[gamelogs/player] ${playerName} (ESPN ${espnId}): renamed ${renamed}, inserted ${inserted}/${rows.length}`)

  return NextResponse.json({
    message: `${playerName}: renamed ${renamed} rows, inserted ${inserted} new rows`,
    playerName,
    espnId,
    total: rows.length,
    renamed,
    inserted,
    skipped: rows.length - renamed - inserted,
  })
}
