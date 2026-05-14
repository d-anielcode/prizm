// /edge — Expected-value-ranked singles
//
// The tier system (LOCK/PLAY/LEAN/FADE) ranks props by raw confidence score
// and ignores the odds attached to each pick. A LEAN at +150 can have a
// bigger edge than a LOCK at -200 if the probability advantage is large
// enough. This page surfaces props where calibrated_prob × decimal_odds − 1
// is positive — every prop here is profitable in expectation, regardless of
// tier label.

import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { calibratedPct } from '@/lib/calibration'
import { ev, evPct } from '@/lib/ev'
import { isPlayerName } from '@/lib/odds-api'
import type { Prop } from '@/types'

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

async function getEdgePicks(): Promise<Array<Prop & { ev: number; evPct: number; cal: number }>> {
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
  const bestMap = new Map<string, Prop & { ev: number; evPct: number; cal: number }>()
  for (const p of rows) {
    // Defensive: drop team-total markets that slipped into props before the
    // ingest-side filter was added. New rows are blocked at /api/props parse
    // time — see lib/odds-api.ts:isPlayerName.
    if (!isPlayerName(p.player_name, p.home_team, p.away_team)) continue
    const e = ev(p.confidence_score, p.odds)
    if (e == null || e <= 0) continue
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`
    const enriched = {
      ...p,
      ev: e,
      evPct: evPct(p.confidence_score, p.odds) ?? 0,
      cal: calibratedPct(p.confidence_score) ?? 0,
    }
    const existing = bestMap.get(key)
    if (!existing || enriched.ev > existing.ev) {
      bestMap.set(key, enriched)
    }
  }

  return [...bestMap.values()].sort((a, b) => b.ev - a.ev)
}

export default async function EdgePage() {
  const picks = await getEdgePicks()

  // Group for quick stats: tier distribution, EV histogram bins
  const byTier: Record<string, number> = { LOCK: 0, PLAY: 0, LEAN: 0, FADE: 0 }
  for (const p of picks) byTier[p.confidence_label ?? 'FADE'] = (byTier[p.confidence_label ?? 'FADE'] ?? 0) + 1

  const top = picks.slice(0, 30)

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 pb-24 sm:pb-8">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-2">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Edge</h1>
        <span className="text-xs text-white/40">{picks.length} +EV picks</span>
      </div>
      <p className="text-sm text-white/50 mb-6 max-w-2xl">
        Picks ranked by <span className="text-white/70">expected value</span> — calibrated
        probability times decimal odds, minus one. Every pick here is profitable in expectation
        regardless of its tier label. A +5% EV pick wins you 5¢ per dollar staked, on average.
      </p>

      {/* Tier mix */}
      <div className="grid grid-cols-4 gap-2 mb-8 text-xs">
        {(['LOCK', 'PLAY', 'LEAN', 'FADE'] as const).map((tier) => (
          <div key={tier} className={`rounded-md border px-3 py-2 ${TIER_COLORS[tier]}`}>
            <div className="font-mono font-semibold">{byTier[tier] ?? 0}</div>
            <div className="opacity-70">{tier}</div>
          </div>
        ))}
      </div>

      {picks.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-white/50">
          <p>No positive-EV picks right now.</p>
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
                <th className="text-right px-2 py-2.5 font-semibold">Win %</th>
                <th className="text-right px-4 py-2.5 font-semibold">Edge</th>
                <th className="text-left px-2 py-2.5 font-semibold">Tier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {top.map((p) => (
                <tr key={`${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <Link
                      href={`/player/${encodeURIComponent(p.player_name)}`}
                      className="font-medium hover:text-primary transition-colors"
                    >
                      {p.player_name}
                    </Link>
                    {p.team && (
                      <span className="ml-2 text-[10px] text-white/40 font-mono">{p.team}</span>
                    )}
                  </td>
                  <td className="px-2 py-3 font-mono text-xs">
                    <span className={p.direction === 'over' ? 'text-emerald-400/80' : 'text-rose-400/80'}>
                      {p.direction === 'over' ? '▲' : '▼'}
                    </span>
                    <span className="ml-1">{p.line} {STAT_LABELS[p.stat_type] ?? p.stat_type}</span>
                  </td>
                  <td className="px-2 py-3 text-right font-mono text-xs">{fmtOdds(p.odds)}</td>
                  <td className="px-2 py-3 text-right font-mono text-xs text-white/80">{p.cal}%</td>
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
        <p><span className="text-white/55">How this works:</span> Win % is the historically-calibrated
          probability the model assigns to this pick. Edge is what you make per dollar staked, on
          average. The book&apos;s implied probability is baked into the odds — when our calibrated
          probability exceeds it, the pick is +EV.</p>
        <p className="mt-2"><span className="text-white/55">Strategy:</span> Pick the top 5–10 by edge,
          stake equal units. A portfolio of +5% EV picks compounds faster than a single LOCK at -150.</p>
      </div>
    </main>
  )
}
