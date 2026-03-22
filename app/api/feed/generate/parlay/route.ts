// /api/feed/generate/parlay
//
// Auto-generates three tiers of curated parlays per day:
//
//   VALUE   (parlay_type='value')   — 1 × 3-leg "Consistent Pick"
//     · 33.3% hit rate · ~5x avg multiplier · 53.7% ROI
//     · No minutes filter — widest player pool
//
//   PREMIUM (parlay_type='premium') — 3 × 4-leg "High Roller"
//     · 15.8% hit rate · ~10x avg multiplier · 30.6% ROI (67.6% with 24+ min filter)
//     · 24+ avg minutes filter — excludes roleplayers
//
//   JACKPOT (parlay_type='jackpot') — 1 × 5-leg "Jackpot"
//     · 11.5% hit rate · ~17.5x avg multiplier · 80.9% ROI
//     · 24+ avg minutes filter — max quality, max payout
//
//   All tiers:
//     · Markets: PTS / REB / 3PM  (assists removed — only 40% hit rate)
//     · Tiers: LOCK + PLAY (direction = over)
//     · Sort by confidence_score descending
//     · No SGP discount (cross-game parlay)
//     · Independent pools — picks can overlap across tiers
//
// GET  ?date=YYYY-MM-DD  — preview without saving
// POST ?date=YYYY-MM-DD  — generate and save to curated_parlays (parlay_type='premium')
//
// Idempotent: POST skips if TARGET parlays already exist for the date.

import { NextResponse }  from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabase }     from '@/lib/supabase'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

const VALUE_LEGS       = 3    // 3-leg "Consistent Pick" — 33.3% hit rate, 53.7% ROI
const PREMIUM_LEGS     = 4    // 4-leg "High Roller"     — 15.8% hit rate, 30.6% ROI (67.6% w/ 24+ mins)
const PREMIUM_COUNT    = 3    // number of premium parlays per day
const PREMIUM_MIN_MINS = 24   // premium: exclude players averaging < 24 min/game
const JACKPOT_LEGS     = 5    // 5-leg "Jackpot"         — 11.5% hit rate, 80.9% ROI
const JACKPOT_MIN_MINS = 24   // jackpot: same 24+ min filter for quality
// Sportsbooks apply extra vig on parlays — displayed multiplier is discounted ~15%
// to give a realistic estimate rather than the raw mathematical product.
const PARLAY_VIG_FACTOR = 0.85
const ALLOWED_MARKETS  = new Set(['points', 'rebounds', 'three_pointers'])  // no assists (40% hit rate)
const ALLOWED_TIERS    = new Set(['LOCK', 'PLAY'])

const STAT_LABELS: Record<string, string> = {
  points:         'PTS',
  rebounds:       'REB',
  three_pointers: '3PM',
  assists:        'AST',
}

const ABBR_NORM: Record<string, string> = { GS: 'GSW', NY: 'NYK', NO: 'NOP', SA: 'SAS', NJ: 'NJN' }
function normaliseAbbr(abbr: string): string { return ABBR_NORM[abbr] ?? abbr }

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

function toDecimal(odds: number | null | undefined): number {
  if (odds == null) return 100 / 130 + 1  // default -130 (realistic avg prop odds)
  if (odds > 0) return odds / 100 + 1
  return 100 / Math.abs(odds) + 1
}

function toEasternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

interface ParlayLeg {
  player_name:      string
  team:             string
  stat_type:        string
  line:             number
  direction:        string
  odds:             number | null
  confidence_label: string
  confidence_score: number
  game_id:          string
  home_team:        string
  away_team:        string
  commence_time:    string
  l10_hits:         number
  l10_total:        number
}

interface ScoredProp {
  player_name:      string
  team:             string | null
  stat_type:        string
  line:             number
  direction:        string
  odds:             number | null
  confidence_label: string
  confidence_score: number
  game_id:          string
  home_team:        string | null
  away_team:        string | null
  commence_time:    string
  l10_hits:         number
  l10_total:        number
  resolvedTeam:     string
  avgMins:          number | null  // avg minutes over last 20 games
}

interface ParlayResult {
  legs:        ParlayLeg[]
  multiplier:  number
  title:       string
  description: string
  tier:        'value' | 'premium' | 'jackpot'
}

// Pick N legs from a pool. globalUsed prevents reusing the same player|stat within
// this parlay group. usedPlayers prevents the same player appearing twice in one parlay.
function pickParlay(
  pool:        ScoredProp[],
  globalUsed:  Set<string>,
  legsNeeded:  number,
  minMins:     number = 0,
): { legs: ParlayLeg[]; used: Set<string> } | null {
  const selected: ParlayLeg[] = []
  const usedPlayers = new Set<string>()

  for (const prop of pool) {
    if (selected.length >= legsNeeded) break
    const key = `${prop.player_name}|${prop.stat_type}`
    if (globalUsed.has(key)) continue
    if (usedPlayers.has(prop.player_name)) continue
    if (minMins > 0 && (prop.avgMins == null || prop.avgMins < minMins)) continue

    selected.push({
      player_name:      prop.player_name,
      team:             prop.resolvedTeam,
      stat_type:        prop.stat_type,
      line:             prop.line,
      direction:        prop.direction,
      odds:             prop.odds,
      confidence_label: prop.confidence_label,
      confidence_score: prop.confidence_score,
      game_id:          prop.game_id,
      home_team:        prop.home_team ?? '',
      away_team:        prop.away_team ?? '',
      commence_time:    prop.commence_time,
      l10_hits:         prop.l10_hits,
      l10_total:        prop.l10_total,
    })

    usedPlayers.add(prop.player_name)
  }

  if (selected.length < legsNeeded) return null
  const used = new Set(selected.map((l) => `${l.player_name}|${l.stat_type}`))
  return { legs: selected, used }
}

function buildResult(
  legs:        ParlayLeg[],
  idx:         number,
  gameDate:    string,
  tier:        'value' | 'premium' | 'jackpot',
): ParlayResult {
  const parlayDecimal = legs.reduce((acc, l) => acc * toDecimal(l.odds), 1)
  // Apply sportsbook parlay vig discount for a conservative displayed estimate
  const multiplier    = Math.round(parlayDecimal * PARLAY_VIG_FACTOR * 10) / 10
  const legStrs = legs.map((l) => {
    const stat   = STAT_LABELS[l.stat_type] ?? l.stat_type
    const l10str = l.l10_total > 0 ? ` (${l.l10_hits}/${l.l10_total} L${l.l10_total})` : ''
    return `${l.player_name} O ${l.line} ${stat}${l10str}`
  })
  const premiumLabels = ['Alpha', 'Beta', 'Gamma']
  const title = tier === 'value'   ? `Consistent Pick · ${gameDate}`
    : tier === 'jackpot'           ? `Jackpot · ${gameDate}`
    : `High Roller ${premiumLabels[idx] ?? idx + 1} · ${gameDate}`
  const description = legStrs.join(' · ') + ` — ~${multiplier}x payout`
  return { legs, multiplier, title, description, tier }
}

async function generateCuratedParlays(gameDate: string): Promise<ParlayResult[]> {
  // 1. Load LOCK/PLAY over props for target date
  const { data: propsRaw, error } = await supabase
    .from('props')
    .select('player_name, team, stat_type, line, direction, odds, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
    .in('confidence_label', ['LOCK', 'PLAY'])
    .eq('direction', 'over')
    .order('confidence_score', { ascending: false })

  if (error || !propsRaw || propsRaw.length === 0) return []

  // Filter to target date + allowed markets
  const eligible = propsRaw.filter((p) =>
    p.commence_time &&
    toEasternDate(p.commence_time) === gameDate &&
    ALLOWED_MARKETS.has(p.stat_type) &&
    ALLOWED_TIERS.has(p.confidence_label ?? '')
  )

  if (eligible.length === 0) return []

  // Dedup: keep highest confidence per player+stat
  const dedupMap = new Map<string, typeof eligible[0]>()
  for (const p of eligible) {
    const key = `${p.player_name}|${p.stat_type}`
    const ex  = dedupMap.get(key)
    if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) dedupMap.set(key, p)
  }
  const props = [...dedupMap.values()].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))

  // 2. Fetch game logs for l10 hit rates + team resolution
  const playerNames = [...new Set(props.map((p) => p.player_name))]
  const { data: logsRaw } = await supabase
    .from('player_game_logs')
    .select('player_name, game_date, matchup, is_home, points, rebounds, assists, fg3m, minutes')
    .in('player_name', playerNames)
    .order('game_date', { ascending: false })
    .limit(playerNames.length * 15)

  const logsByPlayer = new Map<string, Record<string, unknown>[]>()
  const teamByPlayer = new Map<string, string>()
  for (const log of logsRaw ?? []) {
    const name = log.player_name as string
    if (!logsByPlayer.has(name)) logsByPlayer.set(name, [])
    logsByPlayer.get(name)!.push(log as Record<string, unknown>)
    if (!teamByPlayer.has(name) && log.matchup && log.is_home != null) {
      const abbr = teamFromMatchup(log.matchup as string, log.is_home as boolean)
      if (abbr) teamByPlayer.set(name, abbr)
    }
  }

  const STAT_FIELD: Record<string, string> = { points: 'points', rebounds: 'rebounds', three_pointers: 'fg3m', assists: 'assists' }

  // 3. Build scored pool with l10 stats + avg minutes (last 20 qualifying games)
  const pool: ScoredProp[] = props.map((prop) => {
    const allLogs = logsByPlayer.get(prop.player_name) ?? []
    const logs    = allLogs.filter((g) => Number(g.minutes ?? 0) >= 5)
    const l10     = logs.slice(0, 10)
    const last20  = logs.slice(0, 20)
    const field   = STAT_FIELD[prop.stat_type] ?? prop.stat_type
    const l10Hits = l10.filter((g) => Number(g[field] ?? 0) > prop.line).length
    const avgMins = last20.length > 0
      ? last20.reduce((sum, g) => sum + Number(g.minutes ?? 0), 0) / last20.length
      : null
    return {
      player_name:      prop.player_name,
      team:             prop.team,
      stat_type:        prop.stat_type,
      line:             prop.line,
      direction:        prop.direction,
      odds:             prop.odds ?? null,
      confidence_label: prop.confidence_label!,
      confidence_score: prop.confidence_score!,
      game_id:          prop.game_id,
      home_team:        prop.home_team,
      away_team:        prop.away_team,
      commence_time:    prop.commence_time!,
      l10_hits:         l10Hits,
      l10_total:        l10.length,
      resolvedTeam:     teamByPlayer.get(prop.player_name) ?? prop.team ?? 'TBD',
      avgMins:          avgMins !== null ? Math.round(avgMins * 10) / 10 : null,
    }
  })

  // 4. Build VALUE parlay (3-leg, independent pool)
  const results: ParlayResult[] = []
  const valueUsed = new Set<string>()
  const valuePick = pickParlay(pool, valueUsed, VALUE_LEGS)
  if (valuePick) {
    results.push({ ...buildResult(valuePick.legs, 0, gameDate, 'value'), tier: 'value' })
  }

  // 5. Build PREMIUM parlays (4-leg, 24+ avg mins filter, independent pool)
  const premiumUsed = new Set<string>()
  for (let i = 0; i < PREMIUM_COUNT; i++) {
    const pick = pickParlay(pool, premiumUsed, PREMIUM_LEGS, PREMIUM_MIN_MINS)
    if (!pick) break
    results.push({ ...buildResult(pick.legs, i, gameDate, 'premium'), tier: 'premium' })
    for (const key of pick.used) premiumUsed.add(key)
  }

  // 6. Build JACKPOT parlay (5-leg, 24+ avg mins filter, independent pool)
  const jackpotUsed = new Set<string>()
  const jackpotPick = pickParlay(pool, jackpotUsed, JACKPOT_LEGS, JACKPOT_MIN_MINS)
  if (jackpotPick) {
    results.push({ ...buildResult(jackpotPick.legs, 0, gameDate, 'jackpot'), tier: 'jackpot' })
  }

  return results
}

export async function GET(req: Request) {
  const url      = new URL(req.url)
  const gameDate = url.searchParams.get('date')
    ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

  try {
    const results = await generateCuratedParlays(gameDate)
    if (results.length === 0) {
      return NextResponse.json({ message: 'Not enough qualifying props to build any parlay', date: gameDate })
    }
    return NextResponse.json({ date: gameDate, preview: true, count: results.length, parlays: results })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const url      = new URL(req.url)
  const gameDate = url.searchParams.get('date')
    ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const force    = url.searchParams.get('force') === 'true'

  try {
    // Idempotency: skip if we already have value + premium parlays for this date (unless force=true)
    const { data: existing } = await adminClient
      .from('curated_parlays')
      .select('id, parlay_type')
      .eq('game_date', gameDate)
      .in('parlay_type', ['value', 'premium', 'jackpot'])
      .eq('active', true)

    const existingValue   = (existing ?? []).filter((r) => r.parlay_type === 'value').length
    const existingPremium = (existing ?? []).filter((r) => r.parlay_type === 'premium').length
    const existingJackpot = (existing ?? []).filter((r) => r.parlay_type === 'jackpot').length
    const alreadyFull     = existingValue >= 1 && existingPremium >= PREMIUM_COUNT && existingJackpot >= 1

    if (alreadyFull && !force) {
      return NextResponse.json({
        message: `Parlays already generated for ${gameDate} — skipping`,
        date: gameDate,
        saved: 0,
        skipped: true,
      })
    }

    // force=true: delete existing auto-generated parlays so we can regenerate fresh
    if (force && existing && existing.length > 0) {
      const ids = existing.map((r) => r.id)
      await adminClient.from('curated_parlays').delete().in('id', ids)
    }

    const results = await generateCuratedParlays(gameDate)

    if (results.length === 0) {
      return NextResponse.json({
        message: 'Not enough qualifying props to build any parlay',
        date: gameDate,
        saved: 0,
      })
    }

    // Only insert tiers we don't already have; force cleared them so insert all
    const toInsert = force ? results : results.filter((r) => {
      if (r.tier === 'value')   return existingValue   < 1
      if (r.tier === 'premium') return existingPremium < PREMIUM_COUNT
      if (r.tier === 'jackpot') return existingJackpot < 1
      return true
    })

    const rows = toInsert.map((result) => ({
      title:          result.title,
      description:    result.description,
      parlay_type:    result.tier,
      game_date:      gameDate,
      est_multiplier: result.multiplier,
      legs:           result.legs.map((l) => ({
        player_name:      l.player_name,
        team:             l.team,
        stat_type:        l.stat_type,
        line:             l.line,
        direction:        l.direction,
        odds:             l.odds,
        confidence_label: l.confidence_label,
        confidence_score: l.confidence_score,
        l10_hits:         l.l10_hits,
        l10_total:        l.l10_total,
      })),
      active: true,
    }))

    const { data, error } = await adminClient
      .from('curated_parlays')
      .insert(rows)
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      message: `Generated and saved ${rows.length} curated parlay(s) for ${gameDate}`,
      date:    gameDate,
      saved:   rows.length,
      parlays: data,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
