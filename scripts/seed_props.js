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
    const value = trimmed.slice(eqIdx + 1).trim()
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

// ---- Dedup ----
function deduplicateProps(props) {
  const seen = new Set()
  return props.filter((p) => {
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}|${p.sportsbook}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

  // 3. Delete all old props
  console.log('\n[seed] Deleting old props from Supabase...')
  await supabaseRequest('DELETE', `props?id=neq.00000000-0000-0000-0000-000000000000`, null)
  console.log('[seed] Old props deleted.')

  // 4. Insert new props in batches
  const BATCH = 500
  let inserted = 0
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH)
    await supabaseRequest('POST', 'props', batch)
    inserted += batch.length
    console.log(`[seed] Inserted ${inserted}/${deduped.length} props...`)
  }

  // 5. Summary
  const games = [...new Set(deduped.map((p) => p.game_id))]
  const withTeams = deduped.filter((p) => p.home_team && p.away_team).length
  console.log(`\n[seed] Done!`)
  console.log(`  Games:        ${games.length}`)
  console.log(`  Total props:  ${deduped.length}`)
  console.log(`  With teams:   ${withTeams}`)
  console.log(`  Without teams: ${deduped.length - withTeams}`)

  // Log unique games
  const gameSet = new Map()
  for (const p of deduped) {
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
