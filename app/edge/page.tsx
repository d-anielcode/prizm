// /edge — Expected-value-ranked singles
//
// The tier system (LOCK/PLAY/LEAN/FADE) ranks props by raw confidence score
// and ignores the odds attached to each pick. A LEAN at +150 can have a
// bigger edge than a LOCK at -200 if the probability advantage is large
// enough. This page lists props where the model's calibrated probability beats
// the market's implied probability (model EV > 0), within MAX_MODEL_MARKET_GAP.
// It is a research list, not validated bets: on 2025-26 held-out data the model
// added ~nothing beyond the market price, and LOCK/PLAY lost ~5-6% at real odds.

import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { modelVsMarket } from '@/lib/ev'
import { TEAM_ABBR } from '@/lib/team-abbr'
import { fetchEspnRosters, resolvePlayerTeam } from '@/lib/rosters'
import { isPlayerName } from '@/lib/odds-api'
import { loadPlayerBiasMap, biasSignalFor, lookupBias } from '@/lib/player-bias'
import { loadLineupMap, lineupBadgeFor } from '@/lib/lineups'
import { LineupBadge } from '@/components/LineupBadge'
import { PlayerBiasChip } from '@/components/PlayerBiasChip'
import type { Prop, StatType, Direction } from '@/types'

export const dynamic = 'force-dynamic'

const STAT_LABELS: Record<string, string> = {
  points:         'PTS',
  rebounds:       'REB',
  assists:        'AST',
  steals:         'STL',
  blocks:         'BLK',
  three_pointers: '3PM',
  pra:            'PRA',
}

const TIER_COLORS: Record<string, string> = {
  LOCK: 'bg-[#00D68F]/15 text-[#00D68F] border-[#00D68F]/25',
  PLAY: 'bg-[#FFB800]/15 text-[#FFB800] border-[#FFB800]/25',
  LEAN: 'bg-[#3B82F6]/10 text-[#3B82F6] border-[#3B82F6]/20',
  FADE: 'bg-[#FF4757]/10 text-[#FF4757]/70 border-[#FF4757]/15',
}

function fmtOdds(odds: number | null | undefined): string {
  if (odds == null) return '—'
  return odds > 0 ? `+${odds}` : `${odds}`
}

type EdgePick = Prop & { ev: number; evPct: number; cal: number; market: number }

async function getEdgePicks(): Promise<{ picks: EdgePick[]; hiddenImplausible: number }> {
  const now = new Date().toISOString()
  const rows: Prop[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('props')
      .select('*')
      .or(`commence_time.is.null,commence_time.gt.${now}`)
      .not('confidence_score', 'is', null)
      .not('odds', 'is', null)
      .range(from, from + PAGE - 1)
    if (error) { console.error('[edge] supabase error:', error.message); break }
    if (!data || data.length === 0) break
    rows.push(...(data as Prop[]))
    if (data.length < PAGE) break
    from += PAGE
  }

  // Dedup by (player, stat, line, direction) — keep best EV
  const bestMap = new Map<string, EdgePick>()
  let hiddenImplausible = 0
  for (const p of rows) {
    // Defensive: drop team-total markets that slipped into props before the
    // ingest-side filter was added. New rows are blocked at /api/props parse
    // time — see lib/odds-api.ts:isPlayerName.
    if (!isPlayerName(p.player_name, p.home_team, p.away_team)) continue
    const v = modelVsMarket(p.confidence_score, p.odds, p.stat_type)
    if (v == null || v.ev <= 0) continue
    // A gap this large means the calibration (which ignores price) is mis-scoring a
    // long shot, e.g. "47%" for a +450 over 0.5 threes. Not an edge.
    if (!v.plausible) { hiddenImplausible++; continue }
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`
    const enriched: EdgePick = {
      ...p,
      ev: v.ev,
      evPct: Math.round(v.ev * 1000) / 10,
      cal: Math.round(v.modelP * 100),
      market: Math.round(v.marketP * 100),
    }
    const existing = bestMap.get(key)
    if (!existing || enriched.ev > existing.ev) {
      bestMap.set(key, enriched)
    }
  }

  return { picks: [...bestMap.values()].sort((a, b) => b.ev - a.ev), hiddenImplausible }
}

export default async function EdgePage() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [{ picks, hiddenImplausible }, biasMap, lineupMap, roster] = await Promise.all([
    getEdgePicks(),
    loadPlayerBiasMap(),
    loadLineupMap(supabase, todayET),
    fetchEspnRosters(),
  ])
  // props.team is always 'TBD' from the odds feed; resolve from current rosters.
  const teamOf = (p: Prop) => resolvePlayerTeam(p.player_name, null,
    p.home_team ? (TEAM_ABBR[p.home_team] ?? null) : null,
    p.away_team ? (TEAM_ABBR[p.away_team] ?? null) : null, roster).playerTeamAbbr

  // Group for quick stats: tier distribution, EV histogram bins
  const byTier: Record<string, number> = { LOCK: 0, PLAY: 0, FADE: 0 }
  for (const p of picks) byTier[p.confidence_label ?? 'FADE'] = (byTier[p.confidence_label ?? 'FADE'] ?? 0) + 1

  const top = picks.slice(0, 30)

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 pb-24 sm:pb-8">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-2">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Edge</h1>
        <span className="text-xs text-white/40">{picks.length} model +EV picks</span>
      </div>
      <p className="text-sm text-white/50 mb-6 max-w-2xl">
        Props where the model&apos;s probability beats the price, ranked by the model&apos;s
        <span className="text-white/70"> estimated</span> expected value. These are model
        estimates, not proven edges: in 2025-26 testing on held-out games at real odds, the
        model&apos;s picks did not beat the books (LOCK/PLAY returned about −5%).
      </p>

      {/* Tier mix */}
      <div className="grid grid-cols-4 gap-2 mb-8 text-xs">
        {(['LOCK', 'PLAY', 'FADE'] as const).map((tier) => (
          <div key={tier} className={`rounded-md border px-3 py-2 ${TIER_COLORS[tier]}`}>
            <div className="font-mono font-semibold">{byTier[tier] ?? 0}</div>
            <div className="opacity-70">{tier}</div>
          </div>
        ))}
      </div>

      {picks.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-white/50">
          <p>No model +EV picks right now.</p>
          <p className="mt-2 text-xs text-white/35">Either the slate is small or the books are tight tonight.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Player</th>
                <th className="text-left px-2 py-2.5 font-semibold">Pick</th>
                <th className="text-right px-2 py-2.5 font-semibold">Odds</th>
                <th className="text-right px-2 py-2.5 font-semibold">Model %</th>
                <th className="text-right px-2 py-2.5 font-semibold">Market %</th>
                <th className="text-right px-4 py-2.5 font-semibold">Model EV</th>
                <th className="text-left px-2 py-2.5 font-semibold">Tier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {top.map((p) => (
                <tr key={`${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/player/${encodeURIComponent(p.player_name)}`}
                        className="font-medium hover:text-primary transition-colors"
                      >
                        {p.player_name}
                      </Link>
                      <LineupBadge info={lineupBadgeFor(lineupMap, p.player_name)} />
                      {teamOf(p) && (
                        <span className="text-[10px] text-white/40 font-mono">{teamOf(p)}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 font-mono text-xs">
                    <span className={p.direction === 'over' ? 'text-emerald-400/80' : 'text-rose-400/80'}>
                      {p.direction === 'over' ? '▲' : '▼'}
                    </span>
                    <span className="ml-1">{p.line} {STAT_LABELS[p.stat_type] ?? p.stat_type}</span>
                    {(() => {
                      const bias = lookupBias(biasMap, p.player_name, p.stat_type as StatType)
                      const signal = biasSignalFor(bias, p.direction as Direction)
                      return signal ? <span className="ml-2"><PlayerBiasChip signal={signal} /></span> : null
                    })()}
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-xs">{fmtOdds(p.odds)}</td>
                  <td className="px-2 py-3 text-right font-mono text-xs text-white/80">{p.cal}%</td>
                  <td className="px-2 py-3 text-right font-mono text-xs text-white/50">{p.market}%</td>
                  <td className="px-4 py-3 text-right font-mono text-sm font-semibold text-emerald-400">
                    +{p.evPct}%
                  </td>
                  <td className="px-2 py-3">
                    {p.confidence_label && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${TIER_COLORS[p.confidence_label]}`}>
                        {p.confidence_label}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 text-[11px] text-white/35 max-w-2xl">
        <p><span className="text-white/55">How this works:</span> Model % is the historical hit
          rate for props with this confidence score; Market % is the probability implied by the
          odds (vig included). Model EV is what the pick would return per dollar if the model %
          were right. The model&apos;s score doesn&apos;t account for price, so picks where it beats
          the market by more than 10 points are hidden as unreliable
          {hiddenImplausible > 0 ? ` (${hiddenImplausible} tonight)` : ''}.</p>
        <p className="mt-2"><span className="text-white/55">Caution:</span> on 2025-26 data the
          market&apos;s own odds predicted outcomes slightly better than the model, so treat this as
          a research list rather than a betting strategy.</p>
      </div>
    </main>
  )
}
