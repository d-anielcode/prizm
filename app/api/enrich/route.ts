// /api/enrich — Enriches all cached props with AI confidence scores
// Uses real NBA game logs from player_game_logs + team_defense_stats tables.
// Run scripts/fetch_nba_stats.py first to populate those tables.
// Falls back to book-odds scoring if game log data isn't available.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { scoreProps, type GameLog, type TeamDefenseStats, type ScoringContext } from '@/lib/confidence'
import type { Prop, StatType } from '@/types'

async function runEnrichment(force = false) {
  const keyUsed = process.env.SUPABASE_SERVICE_KEY ? 'service_role' : 'anon'
  console.log('[/api/enrich] key:', keyUsed, force ? '(force)' : '')

  // Clear existing scores if forcing full re-score
  if (force) {
    await supabase.from('props').update({
      confidence_score: null,
      confidence_label: null,
      risk_tier: null,
      confidence_reason: null,
    }).not('id', 'is', null)
  }

  // Load ALL unscored props via pagination (Supabase caps at 1000 per request)
  const props: Prop[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data: page, error: pageError } = await supabase
      .from('props')
      .select('*')
      .is('confidence_score', null)
      .range(from, from + PAGE - 1)
    if (pageError) throw new Error(`Supabase read error: ${pageError.message}`)
    if (!page || page.length === 0) break
    props.push(...(page as Prop[]))
    if (page.length < PAGE) break
    from += PAGE
  }
  if (!props || props.length === 0) {
    return { message: 'No props to enrich', enriched: 0, total: 0 }
  }

  // ── Load game logs from Supabase ──────────────────────────────────────────
  const uniqueNames = [...new Set((props as Prop[]).map((p) => p.player_name))]
  console.log(`[/api/enrich] Loading game logs for ${uniqueNames.length} players...`)

  const { data: logRows } = await supabase
    .from('player_game_logs')
    .select('*')
    .in('player_name', uniqueNames)
    .order('game_date', { ascending: false })

  // Group logs by player_name
  const logsMap = new Map<string, GameLog[]>()
  for (const row of logRows ?? []) {
    const name = row.player_name as string
    if (!logsMap.has(name)) logsMap.set(name, [])
    logsMap.get(name)!.push({
      game_date:  row.game_date,
      matchup:    row.matchup,
      is_home:    row.is_home ?? false,
      points:     Number(row.points ?? 0),
      rebounds:   Number(row.rebounds ?? 0),
      assists:    Number(row.assists ?? 0),
      steals:     Number(row.steals ?? 0),
      blocks:     Number(row.blocks ?? 0),
      fg3m:       Number(row.fg3m ?? 0),
      minutes:    Number(row.minutes ?? 0),
      pra:        Number(row.pra ?? 0),
    })
  }

  const playersWithLogs = [...logsMap.values()].filter((l) => l.length >= 3).length
  console.log(`[/api/enrich] Game log data available for ${playersWithLogs}/${uniqueNames.length} players`)

  // ── Load team defensive rankings ──────────────────────────────────────────
  const { data: defRows } = await supabase
    .from('team_defense_stats')
    .select('*')

  const defMap = new Map<string, TeamDefenseStats>()
  for (const row of defRows ?? []) {
    defMap.set(row.team_abbreviation as string, row as TeamDefenseStats)
  }
  console.log(`[/api/enrich] Team defense stats loaded for ${defMap.size} teams`)

  // ── Score every prop ──────────────────────────────────────────────────────
  const updates = (props as Prop[]).map((prop) => {
    const logs = logsMap.get(prop.player_name) ?? []

    // Derive opponent + home/away from prop's team fields + player's game logs
    const { isHome, opponentAbbr } = deriveMatchupContext(prop, logs)
    const defStats = opponentAbbr ? (defMap.get(opponentAbbr) ?? null) : null

    const ctx: ScoringContext = { defStats, isHome, opponentAbbr }
    return scoreProps(prop, logs, null, ctx)
  })

  // ── Batch-upsert to Supabase ──────────────────────────────────────────────
  let enriched = 0
  const BATCH = 200  // smaller batches to avoid payload limits
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH)
    const { error: upsertError } = await supabase
      .from('props')
      .upsert(batch, { onConflict: 'id' })
    if (!upsertError) enriched += batch.length
    else console.error('[/api/enrich] Upsert error:', upsertError.message)
  }

  return {
    message: `Enriched ${enriched} props with AI confidence scores`,
    enriched,
    total: props.length,
    playersWithGameLogs: playersWithLogs,
    teamsWithDefenseData: defMap.size,
  }
}

// ── Team name → abbreviation lookup ──────────────────────────────────────────
const TEAM_ABBR: Record<string, string> = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
  'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
  'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
  'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
  'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
  'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
  'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
}

function getTeamAbbr(fullName: string): string | null {
  return TEAM_ABBR[fullName] ?? null
}

// ── Derive opponent abbreviation + home/away from prop + game logs ────────────
// Game log matchup format: "LAL vs. DEN" (home) or "LAL @ MIL" (away)
// The player's team is always the first token.
function deriveMatchupContext(
  prop: Prop,
  logs: GameLog[],
): { isHome: boolean | null; opponentAbbr: string | null } {
  if (logs.length === 0) return { isHome: null, opponentAbbr: null }

  // Extract player's team from most recent log
  const latestMatchup = logs[0]?.matchup ?? ''
  const matchParts = latestMatchup.split(/\s+vs\.\s+|\s+@\s+/)
  const playerTeamAbbr = matchParts[0]?.trim().toUpperCase()
  if (!playerTeamAbbr) return { isHome: null, opponentAbbr: null }

  // Convert prop's full team names → abbreviations
  const homeAbbr = prop.home_team ? (TEAM_ABBR[prop.home_team] ?? null) : null
  const awayAbbr = prop.away_team ? (TEAM_ABBR[prop.away_team] ?? null) : null

  if (homeAbbr && playerTeamAbbr === homeAbbr) {
    return { isHome: true,  opponentAbbr: awayAbbr }
  }
  if (awayAbbr && playerTeamAbbr === awayAbbr) {
    return { isHome: false, opponentAbbr: homeAbbr }
  }

  // Couldn't match — return neutral
  return { isHome: null, opponentAbbr: null }
}

// ── Route handlers ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get('force') === 'true'
    const result = await runEnrichment(force)
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('[/api/enrich] Error:', message)
    return NextResponse.json({ error: 'Enrichment failed', details: message }, { status: 500 })
  }
}
