// /api/feed/generate/parlay
export const maxDuration = 60
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
//     · Markets: PTS / REB / 3PM / AST  (assists 52.2% hit rate — best performing stat)
//     · Tiers: LOCK + PLAY, both OVER and UNDER (UNDERs hit 50.1% vs OVERs 43.4%)
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
const ALLOWED_MARKETS  = new Set(['points', 'rebounds', 'three_pointers', 'assists'])  // assists hits 52.2% — best stat type
const ALLOWED_TIERS    = new Set(['LOCK', 'PLAY'])

// Minimum lines per stat — filter out trivial/gimme props that aren't real bets
const MIN_LINE: Record<string, number> = {
  points:         10.5,  // must be a meaningful scoring line
  rebounds:       3.5,   // must require real rebounding effort
  three_pointers: 1.5,   // "over 0.5 threes" is a coinflip, not a pick
  assists:        2.5,   // meaningful assist line (52.2% hit rate — best stat type)
}

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
// this parlay group. Correlation rules (enforced strictly then relaxed on fallback):
//   - No same player twice (always enforced)
//   - Max 1 player per team (avoids same-team correlation — strictly enforced first, relaxed on fallback)
//   - Max 2 legs from the same game (cross-game independence — relaxed last)
function pickParlay(
  pool:        ScoredProp[],
  globalUsed:  Set<string>,
  legsNeeded:  number,
  minMins:     number = 0,
): { legs: ParlayLeg[]; used: Set<string> } | null {
  // Always enforce strict team correlation (max 1 per team, max 2 per game).
  // No relaxed fallback — better to return null than build a same-team parlay.
  return _pickParlay(pool, globalUsed, legsNeeded, minMins)
}

function _pickParlay(
  pool:        ScoredProp[],
  globalUsed:  Set<string>,
  legsNeeded:  number,
  minMins:     number,
): { legs: ParlayLeg[]; used: Set<string> } | null {
  const selected: ParlayLeg[] = []
  const usedPlayers = new Set<string>()
  const usedTeams   = new Set<string>()    // for strict mode: max 1 per team
  const gameLegs    = new Map<string, number>()  // game_id → legs from that game

  for (const prop of pool) {
    if (selected.length >= legsNeeded) break
    const key = `${prop.player_name}|${prop.stat_type}`
    if (globalUsed.has(key)) continue
    if (usedPlayers.has(prop.player_name)) continue
    if (minMins > 0 && (prop.avgMins == null || prop.avgMins < minMins)) continue

    // Team correlation guard — always strict: max 1 player per team
    const team = prop.resolvedTeam ?? ''
    if (team && team !== 'TBD' && usedTeams.has(team)) continue

    // Game diversity: max 2 legs from the same game (both teams)
    const gameId = prop.game_id ?? ''
    if (gameId && (gameLegs.get(gameId) ?? 0) >= 2) continue

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
    if (team && team !== 'TBD') usedTeams.add(team)
    if (gameId) gameLegs.set(gameId, (gameLegs.get(gameId) ?? 0) + 1)
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
    const dir = l.direction === 'under' ? 'U' : 'O'
    return `${l.player_name} ${dir} ${l.line} ${stat}${l10str}`
  })
  const premiumLabels = ['Alpha', 'Beta', 'Gamma']
  const title = tier === 'value'   ? `Consistent Pick · ${gameDate}`
    : tier === 'jackpot'           ? `Jackpot · ${gameDate}`
    : `High Roller ${premiumLabels[idx] ?? idx + 1} · ${gameDate}`
  const description = legStrs.join(' · ') + ` — ~${multiplier}x payout`
  return { legs, multiplier, title, description, tier }
}

async function generateCuratedParlays(gameDate: string): Promise<ParlayResult[]> {
  // 1. Load LOCK/PLAY props for target date (both OVER and UNDER — UNDERs hit 50.1% vs OVERs 43.4%)
  const { data: propsRaw, error } = await supabase
    .from('props')
    .select('player_name, team, stat_type, line, direction, odds, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
    .in('confidence_label', ['LOCK', 'PLAY'])
    .order('confidence_score', { ascending: false })

  if (error || !propsRaw || propsRaw.length === 0) return []

  // Filter to target date + allowed markets + minimum line thresholds
  const eligible = propsRaw.filter((p) =>
    p.commence_time &&
    toEasternDate(p.commence_time) === gameDate &&
    ALLOWED_MARKETS.has(p.stat_type) &&
    ALLOWED_TIERS.has(p.confidence_label ?? '') &&
    p.line >= (MIN_LINE[p.stat_type] ?? 0)
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
    const l10Hits = prop.direction === 'under'
      ? l10.filter((g) => Number(g[field] ?? 0) < prop.line).length
      : l10.filter((g) => Number(g[field] ?? 0) > prop.line).length
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

  // 3b. Load recent production accuracy to identify hot stat types.
  //     Hot stat = LOCK hit rate ≥ 62% with ≥ 10 graded samples in last 30 days.
  //     Hot stats get a +5 score bonus so they bubble up in the pool, making them
  //     more likely to be selected for parlays without hard-excluding other types.
  const HOT_LOCK_THRESHOLD = 0.62
  const HOT_MIN_SAMPLES    = 10
  const HOT_BONUS          = 5  // points added to confidence_score for sorting

  try {
    const minGradeDate = new Date(Date.now() - 30 * 86400000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

    const { data: gradeRows } = await supabase
      .from('prop_grades')
      .select('stat_type, confidence_label, result')
      .gte('game_date', minGradeDate)
      .in('result', ['hit', 'miss'])
      .in('confidence_label', ['LOCK'])

    if (gradeRows && gradeRows.length >= HOT_MIN_SAMPLES) {
      // Tally LOCK hit rate per stat
      const tallyMap = new Map<string, { hits: number; total: number }>()
      for (const row of gradeRows) {
        if (!tallyMap.has(row.stat_type)) tallyMap.set(row.stat_type, { hits: 0, total: 0 })
        tallyMap.get(row.stat_type)!.hits  += row.result === 'hit' ? 1 : 0
        tallyMap.get(row.stat_type)!.total += 1
      }
      const hotStats = new Set<string>()
      for (const [stat, { hits, total }] of tallyMap) {
        if (total >= HOT_MIN_SAMPLES && hits / total >= HOT_LOCK_THRESHOLD) hotStats.add(stat)
      }
      // Apply bonus to pool: re-sort with hot-stat adjusted scores
      if (hotStats.size > 0) {
        for (const p of pool) {
          if (hotStats.has(p.stat_type)) {
            p.confidence_score += HOT_BONUS
          }
        }
        pool.sort((a, b) => b.confidence_score - a.confidence_score)
      }
    }
  } catch {
    // Grades not yet available — fall back to unmodified pool order
  }

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

// GET aliases POST so Vercel cron (which uses GET) saves parlays to DB.
// Idempotent by default — skips if already generated. Pass ?force=true to regenerate.
export async function GET(req: Request) {
  return POST(req)
}

export async function POST(req: Request) {
  const url      = new URL(req.url)
  const gameDate = url.searchParams.get('date')
    ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const force    = url.searchParams.get('force') === 'true'
  const stats    = url.searchParams.get('stats') === 'true'

  // ?stats=true — return pool breakdown without saving anything
  if (stats) {
    const { data: propsRaw } = await supabase
      .from('props')
      .select('player_name, team, stat_type, line, direction, confidence_label, confidence_score, game_id, home_team, away_team, commence_time')
      .in('confidence_label', ['LOCK', 'PLAY'])
      .order('confidence_score', { ascending: false })

    const eligible = (propsRaw ?? []).filter((p) =>
      p.commence_time &&
      toEasternDate(p.commence_time) === gameDate &&
      ALLOWED_MARKETS.has(p.stat_type) &&
      (p.line ?? 0) >= (MIN_LINE[p.stat_type] ?? 0)
    )

    const playerNames = [...new Set(eligible.map((p) => p.player_name))]
    const { data: logsRaw } = await supabase
      .from('player_game_logs')
      .select('player_name, game_date, minutes')
      .in('player_name', playerNames)
      .order('game_date', { ascending: false })
      .limit(playerNames.length * 25)

    const avgMinsMap = new Map<string, number | null>()
    const logsByPlayer = new Map<string, number[]>()
    for (const log of logsRaw ?? []) {
      if (!logsByPlayer.has(log.player_name)) logsByPlayer.set(log.player_name, [])
      if (Number(log.minutes ?? 0) >= 5) logsByPlayer.get(log.player_name)!.push(Number(log.minutes))
    }
    for (const name of playerNames) {
      const mins = (logsByPlayer.get(name) ?? []).slice(0, 20)
      avgMinsMap.set(name, mins.length > 0 ? mins.reduce((s, m) => s + m, 0) / mins.length : null)
    }

    const poolSummary = eligible.map((p) => ({
      player: p.player_name,
      team: p.team,
      stat: p.stat_type,
      line: p.line,
      label: p.confidence_label,
      score: p.confidence_score,
      avgMins: avgMinsMap.get(p.player_name) ?? null,
      meetsMinMins: (avgMinsMap.get(p.player_name) ?? 0) >= 24,
    }))

    // Show what got filtered out and why
    const allLockPlay = (propsRaw ?? []).filter((p) =>
      p.commence_time && toEasternDate(p.commence_time) === gameDate
    )
    const byStatDir = new Map<string, number>()
    for (const p of allLockPlay) {
      const k = `${p.stat_type}|${p.direction ?? 'unknown'}`
      byStatDir.set(k, (byStatDir.get(k) ?? 0) + 1)
    }
    const filtered = allLockPlay.filter((p) => !ALLOWED_MARKETS.has(p.stat_type) || (p.line ?? 0) < (MIN_LINE[p.stat_type] ?? 0))
    const filteredReasons = filtered.map((p) => ({
      player: p.player_name,
      stat: p.stat_type,
      line: p.line,
      dir: p.direction,
      label: p.confidence_label,
      reason: !ALLOWED_MARKETS.has(p.stat_type) ? 'market excluded' : 'below min line',
    }))

    return NextResponse.json({
      date: gameDate,
      totalLockPlayToday: allLockPlay.length,
      totalEligible: eligible.length,
      with24MinFilter: poolSummary.filter((p) => p.meetsMinMins).length,
      breakdownByStatDir: Object.fromEntries(byStatDir),
      filteredOut: filteredReasons,
      pool: poolSummary,
    })
  }

  try {
    // force=true: delete existing auto-generated parlays and regenerate fresh
    // Safety guard: if props aren't scored yet (enrich may have failed), abort without
    // deleting so the morning parlays are preserved until scores are available.
    if (force) {
      const { count: scoredCount } = await adminClient
        .from('props')
        .select('id', { count: 'exact', head: true })
        .in('confidence_label', ['LOCK', 'PLAY'])
      if ((scoredCount ?? 0) < 10) {
        console.warn(`[generate/parlay] force=true aborted — only ${scoredCount ?? 0} scored props, preserving existing parlays`)
        return NextResponse.json({
          message: 'Not enough scored props to safely regenerate parlays — existing parlays preserved',
          scoredCount: scoredCount ?? 0,
          date: gameDate,
        })
      }
      const { data: existing } = await adminClient
        .from('curated_parlays')
        .select('id')
        .eq('game_date', gameDate)
        .in('parlay_type', ['value', 'premium', 'jackpot'])
        .eq('active', true)
      if (existing && existing.length > 0) {
        await adminClient.from('curated_parlays').delete().in('id', existing.map((r) => r.id))
      }
    }

    const results = await generateCuratedParlays(gameDate)

    if (results.length === 0) {
      return NextResponse.json({
        message: 'Not enough qualifying props to build any parlay',
        date: gameDate,
        saved: 0,
      })
    }

    // Idempotency: fetch existing titles for this date so we skip any already saved.
    // Using title as a natural unique key prevents race conditions — concurrent calls
    // that generate the same parlay will simply skip on the duplicate-title check.
    const { data: existingTitles } = await adminClient
      .from('curated_parlays')
      .select('title')
      .eq('game_date', gameDate)
      .in('parlay_type', ['value', 'premium', 'jackpot'])
      .eq('active', true)

    const savedTitles = new Set((existingTitles ?? []).map((r: { title: string }) => r.title))
    const toInsert = results.filter((r) => !savedTitles.has(r.title))

    if (toInsert.length === 0) {
      return NextResponse.json({
        message: `Parlays already generated for ${gameDate} — skipping`,
        date: gameDate,
        saved: 0,
        skipped: true,
      })
    }

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

    // Fire-and-forget streak generation alongside parlays (same cron, no extra slot needed)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000'
    fetch(`${baseUrl}/api/feed/generate/streak?date=${gameDate}${force ? '&force=true' : ''}`)
      .catch((e) => console.error('[generate/parlay] streak fire-and-forget error:', e))

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
