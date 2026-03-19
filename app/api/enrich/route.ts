// /api/enrich — Enriches all cached props with AI confidence scores
// Uses real NBA game logs from player_game_logs + team_defense_stats tables.
// Run scripts/fetch_nba_stats.py first to populate those tables.
// Falls back to book-odds scoring if game log data isn't available.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { scoreProps, type GameLog, type TeamDefenseStats } from '@/lib/confidence'
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

  // Load unscored props (top 500 by insertion order)
  const { data: props, error } = await supabase
    .from('props')
    .select('*')
    .is('confidence_score', null)
    .limit(500)

  if (error) throw new Error(`Supabase read error: ${error.message}`)
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

    // Find opponent team abbreviation from game logs or prop data
    // Matchup format: "LAL vs. DEN" (home) or "LAL @ DEN" (away)
    // opponent field on prop is often 'TBD' — try to infer from prop data
    const oppTeam = prop.opponent !== 'TBD' ? getTeamAbbr(prop.opponent) : null
    const defStats = oppTeam ? (defMap.get(oppTeam) ?? null) : null

    return scoreProps(prop, logs, null, defStats)
  })

  // ── Batch-upsert to Supabase ──────────────────────────────────────────────
  let enriched = 0
  const BATCH = 500
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
