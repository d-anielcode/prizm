// /api/feed/generate — Auto-generate curated 4-leg SGPs from today's LOCK/PLAY props
//
// GET  ?date=YYYY-MM-DD  — preview without saving
// POST ?date=YYYY-MM-DD  — generate and save to curated_parlays
//
// Selection criteria per leg:
//   · LOCK or PLAY tier, confidence_score >= 66
//   · Actual L10 hit rate >= 60% (6+/10 recent games)
//   · Actual L5 hit rate >= 60% (not cold recently)
//   · At least 5 qualifying games (minutes >= 5) in log history
//
// SGP structure per game:
//   · 3–4 legs, aiming for both teams when possible (at least 2 players)
//   · Ranked by SGP score = L10Rate(50%) + NormConfidence(30%) + Momentum(20%)
//   · Published only if avg quality score >= 0.70

import { NextResponse }  from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabase }     from '@/lib/supabase'
import { TEAM_ABBR }    from '@/lib/team-abbr'
import type { StatType } from '@/types'

// Admin client uses the service role key, which bypasses RLS for writes
const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAT_DB_FIELD: Record<StatType, string> = {
  points:         'points',
  rebounds:       'rebounds',
  assists:        'assists',
  steals:         'steals',
  blocks:         'blocks',
  three_pointers: 'fg3m',
  pra:            'pra',
}

const STAT_LABELS: Record<string, string> = {
  points:         'PTS',
  rebounds:       'REB',
  assists:        'AST',
  steals:         'STL',
  blocks:         'BLK',
  three_pointers: '3PM',
  pra:            'PRA',
}

function getStatValue(log: Record<string, unknown>, statType: string): number {
  const field = STAT_DB_FIELD[statType as StatType] ?? statType
  return Number(log[field] ?? 0)
}

function toEasternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// Normalise short ESPN abbreviations to canonical 3-letter codes
const ABBR_NORM: Record<string, string> = {
  GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', NJ: 'NJN',
}
function normaliseAbbr(abbr: string): string { return ABBR_NORM[abbr] ?? abbr }

// Derive team abbreviation from a game log matchup + is_home flag.
// Two formats exist: "AWAY @ HOME" and "HOME vs. AWAY"
function teamFromMatchup(matchup: string, isHome: boolean): string | null {
  if (matchup.includes(' @ ')) {
    const [away, home] = matchup.split(' @ ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  if (matchup.includes(' vs. ')) {
    const [home, away] = matchup.split(' vs. ')
    return normaliseAbbr((isHome ? home : away).trim())
  }
  return null
}

// ── ESPN game data ─────────────────────────────────────────────────────────────

interface GameOdds { spread: number; total: number | null }

/** Fetch today's NBA spreads + O/U totals from ESPN scoreboard. */
async function fetchGameOdds(): Promise<Map<string, GameOdds>> {
  const map = new Map<string, GameOdds>()
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
      { next: { revalidate: 3600 } },
    )
    if (!res.ok) return map
    const data = await res.json() as {
      events?: Array<{
        competitions?: Array<{
          competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>
          odds?: Array<{ details?: string; overUnder?: number }>
        }>
      }>
    }
    for (const event of data.events ?? []) {
      for (const comp of event.competitions ?? []) {
        const rawHome = comp.competitors?.find((c) => c.homeAway === 'home')?.team?.abbreviation
        const rawAway = comp.competitors?.find((c) => c.homeAway === 'away')?.team?.abbreviation
        if (!rawHome || !rawAway) continue
        const home = normaliseAbbr(rawHome)
        const away = normaliseAbbr(rawAway)
        const oddsEntry = comp.odds?.[0]
        const match     = (oddsEntry?.details ?? '').match(/-?\d+(\.\d+)?/)
        if (!match) continue
        const spread = Math.abs(parseFloat(match[0]))
        if (isNaN(spread)) continue
        const total = oddsEntry?.overUnder != null ? Number(oddsEntry.overUnder) : null
        const entry: GameOdds = { spread, total }
        map.set(`${home}|${away}`, entry)
        map.set(`${away}|${home}`, entry)
      }
    }
  } catch { /* ESPN unreachable — default to neutral */ }
  return map
}

/**
 * Score the game context for SGP quality (0–1).
 *
 * Competitive games (low spread) reduce blowout / garbage-time risk.
 * Directional alignment: under-heavy SGPs prefer defensive (low-total) games;
 * over-heavy SGPs prefer higher-scoring games.
 */
function gameScore(odds: GameOdds | null, legs: ScoredLeg[]): number {
  // Spread factor — penalise blowout risk
  let spreadFactor = 0.80  // neutral when no data
  if (odds?.spread != null) {
    const s = odds.spread
    spreadFactor = s <= 3.5 ? 1.00
                : s <= 6   ? 0.90
                : s <= 8.5 ? 0.75
                : s <= 11  ? 0.55
                :            0.35
  }

  // Total alignment factor — do prop directions match the game environment?
  let totalFactor = 0.80  // neutral when no data
  if (odds?.total != null) {
    const t = odds.total
    const underLegs = legs.filter((l) => l.direction === 'under').length
    const isUnderHeavy = underLegs > legs.length / 2
    // Defensive game (low total) → under props more likely to hit
    // Offensive game (high total) → over props more likely to hit
    const aligned = (t < 218 && isUnderHeavy) || (t > 228 && !isUnderHeavy)
    const neutral = t >= 218 && t <= 228
    totalFactor = aligned ? 1.00 : neutral ? 0.85 : 0.65
  }

  return spreadFactor * 0.60 + totalFactor * 0.40
}

function calcMultiplier(legs: ScoredLeg[]): number {
  const product = legs.reduce((acc, leg) => {
    const o = leg.odds ?? -110
    const dec = o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1
    return acc * dec
  }, 1)
  return Math.round(product * 0.60 * 10) / 10  // 40% SGP discount
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScoredLeg {
  player_name:      string
  team:             string   // resolved from game logs
  stat_type:        string
  line:             number
  direction:        'over' | 'under'
  odds?:            number
  confidence_label: string
  confidence_score: number
  game_id:          string
  home_team:        string
  away_team:        string
  commence_time:    string
  l10_hits:         number
  l10_total:        number
  l5_hits:          number
  l5_total:         number
  sgp_score:        number
}

interface SGPResult {
  gameId:       string
  homeTeam:     string
  awayTeam:     string
  commenceTime: string
  legs:         ScoredLeg[]
  legQuality:   number   // avg leg score only
  gameScore:    number   // game context score (spread + total alignment)
  quality:      number   // blended: 75% leg + 25% game
  spread:       number | null
  gameTotal:    number | null
  multiplier:   number
}

// ── Core algorithm ────────────────────────────────────────────────────────────

async function generateSGPs(gameDate: string): Promise<SGPResult[]> {
  // 0. Fetch game odds (spread + total) for blowout-risk and alignment scoring
  const gameOddsMap = await fetchGameOdds()

  // 1. Load LOCK/PLAY props for today
  const { data: propsRaw, error: propsError } = await supabase
    .from('props')
    .select('player_name, team, stat_type, line, direction, odds, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
    .in('confidence_label', ['LOCK', 'PLAY'])
    .gte('confidence_score', 66)
    .order('confidence_score', { ascending: false })

  if (propsError || !propsRaw || propsRaw.length === 0) return []

  // Filter to today (Eastern)
  const todayProps = propsRaw.filter(
    (p) => p.commence_time && toEasternDate(p.commence_time) === gameDate,
  )
  if (todayProps.length === 0) return []

  // Deduplicate: keep highest-confidence per player+stat+direction
  const propMap = new Map<string, typeof todayProps[0]>()
  for (const p of todayProps) {
    const key = `${p.player_name}|${p.stat_type}|${p.direction}`
    const ex  = propMap.get(key)
    if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) propMap.set(key, p)
  }
  const props = [...propMap.values()]

  // 2. Fetch recent game logs for all relevant players
  const playerNames = [...new Set(props.map((p) => p.player_name))]
  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, matchup, is_home, points, rebounds, assists, steals, blocks, fg3m, pra, minutes')
    .in('player_name', playerNames)
    .order('game_date', { ascending: false })
    .limit(playerNames.length * 25)

  // Index logs by player, also derive team abbreviation from most recent log
  const logsByPlayer    = new Map<string, Record<string, unknown>[]>()
  const teamByPlayer    = new Map<string, string>()  // player → resolved team abbr
  for (const log of logsRaw ?? []) {
    const name = log.player_name as string
    if (!logsByPlayer.has(name)) logsByPlayer.set(name, [])
    logsByPlayer.get(name)!.push(log as Record<string, unknown>)

    // Derive team from most recent log (first occurrence = most recent)
    if (!teamByPlayer.has(name) && log.matchup && log.is_home != null) {
      const abbr = teamFromMatchup(log.matchup as string, log.is_home as boolean)
      if (abbr) teamByPlayer.set(name, abbr)
    }
  }

  // 3. Score each prop
  const scoredLegs: ScoredLeg[] = []

  for (const prop of props) {
    if (!prop.home_team || !prop.away_team || !prop.commence_time) continue

    const logs       = logsByPlayer.get(prop.player_name) ?? []
    const activeLogs = logs.filter((g) => Number(g.minutes ?? 0) >= 5)
    if (activeLogs.length < 5) continue  // need at least 5 qualifying games

    const isHit = (g: Record<string, unknown>) => {
      const val = getStatValue(g, prop.stat_type)
      return prop.direction === 'over' ? val > prop.line : val < prop.line
    }

    const l10     = activeLogs.slice(0, 10)
    const l5      = activeLogs.slice(0, 5)
    const l10Hits = l10.filter(isHit).length
    const l5Hits  = l5.filter(isHit).length
    const l10Rate = l10Hits / l10.length
    const l5Rate  = l5Hits  / l5.length

    if (l10Rate < 0.60) continue  // must hit at least 60% in L10
    if (l5Rate  < 0.60) continue  // must not be cold in L5

    const momentum = l5Rate >= l10Rate ? 1.0 : Math.min(1, l5Rate / l10Rate)
    const normConf = Math.min(1, Math.max(0, ((prop.confidence_score ?? 66) - 66) / 24))
    const sgpScore = l10Rate * 0.50 + normConf * 0.30 + momentum * 0.20

    const resolvedTeam = teamByPlayer.get(prop.player_name) ?? prop.team ?? 'TBD'

    scoredLegs.push({
      player_name:      prop.player_name,
      team:             resolvedTeam,
      stat_type:        prop.stat_type,
      line:             prop.line,
      direction:        prop.direction as 'over' | 'under',
      odds:             prop.odds ?? undefined,
      confidence_label: prop.confidence_label!,
      confidence_score: prop.confidence_score!,
      game_id:          prop.game_id,
      home_team:        prop.home_team,
      away_team:        prop.away_team,
      commence_time:    prop.commence_time,
      l10_hits:         l10Hits,
      l10_total:        l10.length,
      l5_hits:          l5Hits,
      l5_total:         l5.length,
      sgp_score:        sgpScore,
    })
  }

  if (scoredLegs.length === 0) return []

  // 4. Group by game, select best 3–4 legs
  const byGame = new Map<string, ScoredLeg[]>()
  for (const leg of scoredLegs) {
    if (!byGame.has(leg.game_id)) byGame.set(leg.game_id, [])
    byGame.get(leg.game_id)!.push(leg)
  }

  const results: SGPResult[] = []

  for (const [gameId, legs] of byGame) {
    if (legs.length < 2) continue  // need at least 2 legs

    const sample   = legs[0]
    const homeAbbr = TEAM_ABBR[sample.home_team] ?? sample.home_team
    const awayAbbr = TEAM_ABBR[sample.away_team] ?? sample.away_team

    // Sort best first, pick unique players
    const sorted = [...legs].sort((a, b) => b.sgp_score - a.sgp_score)

    // Try to build a team-balanced 4-leg SGP (2 home + 2 away)
    // Fall back to best-4 if we can't achieve balance
    const pickUniquePlayers = (pool: ScoredLeg[], max: number): ScoredLeg[] => {
      const seen: Set<string> = new Set()
      const picks: ScoredLeg[] = []
      for (const l of pool) {
        if (picks.length >= max) break
        if (!seen.has(l.player_name)) { picks.push(l); seen.add(l.player_name) }
      }
      return picks
    }

    const homeLegs = sorted.filter((l) => l.team === homeAbbr)
    const awayLegs = sorted.filter((l) => l.team === awayAbbr)

    // Hard requirement: at least 1 from each side
    if (homeLegs.length < 1 || awayLegs.length < 1) continue

    // Build selection: up to 2 from each team, cap total at 3 legs
    // Backtest showed 3-leg SGPs hit 30% vs 4-leg at 12.5% — 3 is the sweet spot
    const homePicks = pickUniquePlayers(homeLegs, 2)
    const awayPicks = pickUniquePlayers(awayLegs, 2)
    const selected  = [...homePicks, ...awayPicks]
      .sort((a, b) => b.sgp_score - a.sgp_score)
      .slice(0, 3)  // hard cap at 3 legs

    // Need at least 3 legs total (with at least 1 confirmed from each team)
    if (selected.length < 3) continue

    const legQuality = selected.reduce((s, l) => s + l.sgp_score, 0) / selected.length

    // Look up game odds using normalised abbreviations
    const odds      = gameOddsMap.get(`${homeAbbr}|${awayAbbr}`) ?? null
    const gScore    = gameScore(odds, selected)
    const quality   = legQuality * 0.75 + gScore * 0.25

    if (quality < 0.62) continue  // overall quality gate

    results.push({
      gameId,
      homeTeam:     sample.home_team,
      awayTeam:     sample.away_team,
      commenceTime: sample.commence_time,
      legs:         selected,
      legQuality,
      gameScore:    gScore,
      quality,
      spread:       odds?.spread ?? null,
      gameTotal:    odds?.total  ?? null,
      multiplier:   calcMultiplier(selected),
    })
  }

  return results.sort((a, b) => b.quality - a.quality)
}

// ── Title / description builders ──────────────────────────────────────────────

function buildTitle(sgp: SGPResult): string {
  const away = TEAM_ABBR[sgp.awayTeam] ?? sgp.awayTeam
  const home = TEAM_ABBR[sgp.homeTeam] ?? sgp.homeTeam
  return `${away} @ ${home} — ${sgp.legs.length}-Leg SGP`
}

function buildDescription(sgp: SGPResult): string {
  const parts = sgp.legs.map((l) => {
    const stat = STAT_LABELS[l.stat_type] ?? l.stat_type
    const dir  = l.direction === 'over' ? 'O' : 'U'
    return `${l.player_name} ${dir} ${l.line} ${stat} (${l.l10_hits}/${l.l10_total} L${l.l10_total})`
  })
  const avgPct = Math.round(
    sgp.legs.reduce((s, l) => s + l.l10_hits / l.l10_total, 0) / sgp.legs.length * 100
  )
  const gameCtx = sgp.spread != null
    ? ` · spread ${sgp.spread}, total ${sgp.gameTotal ?? '?'}`
    : ''
  return `${parts.join(' · ')} — avg ${avgPct}% hit rate across legs${gameCtx}`
}

// ── Route handlers ────────────────────────────────────────────────────────────

// GET aliases POST so Vercel cron jobs (which always send GET) save SGPs
export async function GET(req: Request) {
  return POST(req)
}

export async function POST(req: Request) {
  const url      = new URL(req.url)
  const gameDate = url.searchParams.get('date')
    ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  try {
    // Dedup guard: skip if SGPs already generated for this date
    const { data: existing } = await adminClient
      .from('curated_parlays')
      .select('id')
      .eq('game_date', gameDate)
      .eq('parlay_type', 'sgp')
      .eq('active', true)
      .limit(1)

    if (existing && existing.length > 0) {
      return NextResponse.json({
        message: `SGPs already generated for ${gameDate} — skipping to avoid duplicates`,
        date: gameDate,
        saved: 0,
        skipped: true,
      })
    }

    const sgps = await generateSGPs(gameDate)

    if (sgps.length === 0) {
      return NextResponse.json({
        message: 'No qualifying SGPs found — not enough LOCK/PLAY props with sufficient hit history',
        date: gameDate,
        saved: 0,
      })
    }

    const rows = sgps.map((sgp) => ({
      title:          buildTitle(sgp),
      description:    buildDescription(sgp),
      parlay_type:    'sgp',
      game_date:      gameDate,
      est_multiplier: sgp.multiplier,
      legs:           sgp.legs.map((l) => ({
        player_name:      l.player_name,
        team:             l.team,
        stat_type:        l.stat_type,
        line:             l.line,
        direction:        l.direction,
        odds:             l.odds ?? null,
        confidence_label: l.confidence_label,
        confidence_score: l.confidence_score,
        l10_hits:         l.l10_hits,
        l10_total:        l.l10_total,
        l5_hits:          l.l5_hits,
        l5_total:         l.l5_total,
        spread:           sgp.spread,
        game_total:       sgp.gameTotal,
        game_score:       Math.round(sgp.gameScore * 1000) / 1000,
      })),
      active: true,
    }))

    const { data, error } = await adminClient
      .from('curated_parlays')
      .insert(rows)
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      message: `Generated and saved ${rows.length} SGP(s) for ${gameDate}`,
      date:    gameDate,
      saved:   rows.length,
      parlays: data,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
