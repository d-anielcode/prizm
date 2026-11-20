#!/usr/bin/env node
/**
 * seed_props.js — Standalone Node.js seeder for NBA IQ props.
 *
 * Fetches events and props from odds-api.io, then inserts them into Supabase
 * with home_team and away_team populated on every prop row.
 *
 * Usage:
 *   node scripts/seed_props.js
 *
 * Reads credentials from .env.local (same directory as this script's parent).
 */

const fs = require('fs')
const path = require('path')

// ---- Load .env.local ----
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env.local')
  if (!fs.existsSync(envPath)) {
    console.error('[seed] ERROR: .env.local not found at', envPath)
    process.exit(1)
  }
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && !(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadEnv()

const ODDS_API_IO_KEY = process.env.ODDS_API_IO_KEY
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!ODDS_API_IO_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[seed] ERROR: Missing required env vars. Check .env.local')
  process.exit(1)
}

const BASE_URL = 'https://api.odds-api.io/v3'
const BOOKMAKERS = 'DraftKings,FanDuel'

// ---- Stat label map (mirrors lib/odds-api.ts) ----
const LABEL_STAT_MAP = {
  'Points':        'points',
  'Rebounds':      'rebounds',
  'Assists':       'assists',
  'Steals':        'steals',
  'Blocks':        'blocks',
  '3 Point FG':    'three_pointers',
  'Pts+Rebs+Asts': 'pra',
}

// ---- Supabase REST helpers ----
async function supabaseRequest(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`)
  }
  if (method === 'GET') {
    return res.json()
  }
  return null
}

// ---- odds-api.io helpers ----
function decimalToAmerican(decimal) {
  if (decimal >= 2) return Math.round((decimal - 1) * 100)
  return Math.round(-100 / (decimal - 1))
}

async function fetchNBAEvents() {
  const url = `${BASE_URL}/events?apiKey=${ODDS_API_IO_KEY}&sport=basketball&league=usa-nba&status=pending`
  console.log('[seed] Fetching NBA events...')
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`events failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  const events = Array.isArray(data) ? data : (data.data ?? [])
  console.log(`[seed] Found ${events.length} pending NBA events`)
  return events
}

async function fetchPropsForEvents(events) {
  const allProps = []
  const BATCH = 10

  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH)
    const ids = batch.map((e) => String(e.id)).join(',')

    const url = `${BASE_URL}/odds/multi?apiKey=${ODDS_API_IO_KEY}&eventIds=${ids}&bookmakers=${BOOKMAKERS}`
    console.log(`[seed] Fetching props for events: ${ids}`)
    const res = await fetch(url)
    if (!res.ok) {
      console.error(`[seed] /odds/multi failed: ${res.status} ${await res.text()}`)
      continue
    }

    const data = await res.json()
    const eventList = Array.isArray(data) ? data : (data.data ?? [])

    for (const ev of eventList) {
      // Find the matching event for metadata
      const meta = events.find((e) => String(e.id) === String(ev.id))
      const commenceTime = meta?.date ?? ev.date
      const homeTeam = ev.home ?? meta?.home
      const awayTeam = ev.away ?? meta?.away

      for (const [bookmaker, markets] of Object.entries(ev.bookmakers ?? {})) {
        const ppMarket = Array.isArray(markets)
          ? markets.find((m) => m.name === 'Player Props')
          : null
        if (!ppMarket) continue

        for (const entry of ppMarket.odds ?? []) {
          if (!entry.label || entry.hdp == null) continue

          // Label format: "Player Name (Stat Type)"
          const match = entry.label.match(/^(.+) \(([^)]+)\)$/)
          if (!match) continue

          const playerName = match[1].trim()
          const statKey = match[2].trim()
          const statType = LABEL_STAT_MAP[statKey]
          if (!statType) continue

          for (const direction of ['over', 'under']) {
            const decimal = parseFloat(direction === 'over' ? entry.over : entry.under)
            allProps.push({
              player_id: 0,
              player_name: playerName,
              team: 'TBD',
              opponent: 'TBD',
              game_id: String(ev.id),
              stat_type: statType,
              line: entry.hdp,
              direction,
              odds: isNaN(decimal) ? null : decimalToAmerican(decimal),
              sportsbook: bookmaker,
              commence_time: commenceTime,
              home_team: homeTeam ?? null,
              away_team: awayTeam ?? null,
              cached_at: new Date().toISOString(),
            })
          }
        }
      }
    }
  }

  return allProps
}

// ---- Dedup + Main/Alt separation ----
// Mirrors lib/dedup.ts — picks canonical line per player+stat, rest become alts
function deduplicateProps(props) {
  const seen = new Set()
  const unique = props.filter((p) => {
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}|${p.sportsbook}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique
}

function distTo110(odds) {
  if (odds == null) return Infinity
  return Math.abs(Math.abs(odds) - 110)
}

// Pick one main line per player+stat+direction, then generate ±1 synthetic alts
function separateMainAndAlts(props) {
  // Find canonical line per player+stat (shared over+under line closest to -110)
  const byPlayerStat = new Map()
  for (const p of props) {
    const key = `${p.player_name}|${p.stat_type}`
    if (!byPlayerStat.has(key)) byPlayerStat.set(key, { over: [], under: [] })
    byPlayerStat.get(key)[p.direction].push(p)
  }

  const canonicalLine = new Map()
  for (const [key, { over, under }] of byPlayerStat) {
    if (over.length === 0) continue
    if (under.length > 0) {
      const overLineSet = new Set(over.map((p) => p.line))
      const sharedLines = under.filter((p) => overLineSet.has(p.line)).map((p) => p.line)
      if (sharedLines.length > 0) {
        const best = sharedLines.sort((a, b) => {
          const oA = over.find((p) => p.line === a)
          const oB = over.find((p) => p.line === b)
          return distTo110(oA?.odds) - distTo110(oB?.odds)
        })[0]
        canonicalLine.set(key, best)
        continue
      }
    }
    const mainOver = [...over].sort((a, b) => distTo110(a.odds) - distTo110(b.odds))[0]
    canonicalLine.set(key, mainOver.line)
  }

  // Pick one main prop per player+stat+direction
  const groups = new Map()
  for (const p of props) {
    const key = `${p.player_name}|${p.stat_type}|${p.direction}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(p)
  }

  const mainProps = []
  for (const [groupKey, group] of groups) {
    const psKey = groupKey.split('|').slice(0, 2).join('|')
    const canon = canonicalLine.get(psKey)
    group.sort((a, b) => {
      const aCanon = a.line === canon ? 0 : 1
      const bCanon = b.line === canon ? 0 : 1
      if (aCanon !== bCanon) return aCanon - bCanon
      return distTo110(a.odds) - distTo110(b.odds)
    })
    mainProps.push(group[0])
  }

  // Generate ±1 synthetic alt lines from each main prop
  const STEP = { points: 2, pra: 2, rebounds: 1, assists: 1, steals: 1, blocks: 1, three_pointers: 1 }
  const altProps = mainProps.flatMap((p) => {
    const step = STEP[p.stat_type] || 1
    return [-1, 1]
      .map((n) => Math.round((p.line + n * step) * 2) / 2)
      .filter((altLine) => altLine >= 0.5)
      .map((altLine) => ({
        player_name:   p.player_name,
        stat_type:     p.stat_type,
        direction:     p.direction,
        game_id:       p.game_id,
        line:          altLine,
        odds:          null,
        sportsbook:    p.sportsbook,
        home_team:     p.home_team,
        away_team:     p.away_team,
        commence_time: p.commence_time,
        cached_at:     p.cached_at,
      }))
  })

  return { mainProps, altProps }
}

// ---- Main ----
async function main() {
  console.log('[seed] Starting NBA IQ prop seeder...\n')

  // 1. Fetch events
  const events = await fetchNBAEvents()
  if (events.length === 0) {
    console.log('[seed] No pending NBA events found. Nothing to seed.')
    return
  }

  // 2. Fetch props
  const rawProps = await fetchPropsForEvents(events)
  console.log(`\n[seed] Fetched ${rawProps.length} raw props`)

  const deduped = deduplicateProps(rawProps)
  console.log(`[seed] After dedup: ${deduped.length} props`)

  if (deduped.length === 0) {
    console.log('[seed] No props to insert.')
    return
  }

  // 3. Separate main lines from alt lines
  const { mainProps, altProps } = separateMainAndAlts(deduped)
  console.log(`[seed] Main lines: ${mainProps.length}, Alt lines: ${altProps.length}`)

  const BATCH = 500

  // 4. Snapshot existing enriched props to prop_history before deleting
  const gameDates = [...new Set(mainProps.map((p) => {
    if (!p.commence_time) return null
    return new Date(p.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  }).filter(Boolean))]

  for (const date of gameDates) {
    const startOfDay = `${date}T00:00:00.000Z`
    const endOfDay   = `${date}T23:59:59.999Z`
    const existing = await supabaseRequest(
      'GET',
      `props?commence_time=gte.${startOfDay}&commence_time=lte.${endOfDay}&confidence_label=not.is.null&select=*&limit=10000`,
      null
    )
    if (existing && existing.length > 0) {
      const historyRows = existing.map((p) => {
        const gameDate = p.commence_time
          ? new Date(p.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
          : date
        return { ...p, game_date: gameDate }
      })
      for (let i = 0; i < historyRows.length; i += BATCH) {
        const batch = historyRows.slice(i, i + BATCH)
        await supabaseRequest('POST', 'prop_history?on_conflict=id,game_date', batch)
      }
      console.log(`[seed] Snapshotted ${existing.length} enriched props to prop_history for ${date}`)
    }
  }

  // 5. Delete old props scoped to today's game dates only (not the entire table)
  console.log(`\n[seed] Deleting old props for game dates: ${gameDates.join(', ')}...`)
  for (const date of gameDates) {
    const startOfDay = `${date}T00:00:00.000Z`
    const endOfDay   = `${date}T23:59:59.999Z`
    await supabaseRequest('DELETE', `props?commence_time=gte.${startOfDay}&commence_time=lte.${endOfDay}`, null)
    await supabaseRequest('DELETE', `prop_alts?commence_time=gte.${startOfDay}&commence_time=lte.${endOfDay}`, null)
  }
  console.log('[seed] Old props + alts for target dates deleted.')

  // 6. Insert main props in batches
  let inserted = 0
  for (let i = 0; i < mainProps.length; i += BATCH) {
    const batch = mainProps.slice(i, i + BATCH)
    await supabaseRequest('POST', 'props', batch)
    inserted += batch.length
    console.log(`[seed] Inserted ${inserted}/${mainProps.length} main props...`)
  }

  // 7. Insert alt lines in batches
  if (altProps.length > 0) {
    let altInserted = 0
    for (let i = 0; i < altProps.length; i += BATCH) {
      const batch = altProps.slice(i, i + BATCH)
      await supabaseRequest('POST', 'prop_alts', batch)
      altInserted += batch.length
      console.log(`[seed] Inserted ${altInserted}/${altProps.length} alt lines...`)
    }
  }

  // 8. Summary
  const games = [...new Set(mainProps.map((p) => p.game_id))]
  const withTeams = mainProps.filter((p) => p.home_team && p.away_team).length
  console.log(`\n[seed] Done!`)
  console.log(`  Games:        ${games.length}`)
  console.log(`  Main props:   ${mainProps.length}`)
  console.log(`  Alt lines:    ${altProps.length}`)
  console.log(`  With teams:   ${withTeams}`)
  console.log(`  Without teams: ${mainProps.length - withTeams}`)

  // Log unique games
  const gameSet = new Map()
  for (const p of mainProps) {
    if (!gameSet.has(p.game_id)) {
      gameSet.set(p.game_id, { home: p.home_team, away: p.away_team, time: p.commence_time })
    }
  }
  console.log('\n[seed] Games seeded:')
  for (const [id, info] of gameSet) {
    const matchup = info.home && info.away ? `${info.away} @ ${info.home}` : `Game ${id}`
    console.log(`  ${matchup} — ${info.time ?? 'no time'}`)
  }
}

main().catch((err) => {
  console.error('[seed] Fatal error:', err.message)
  process.exit(1)
})
