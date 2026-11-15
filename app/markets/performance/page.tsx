import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { STAT_LABEL, type MarketStat } from '@/lib/kalshi/ladder'
import { loadLoggedPicks, type ModelPickRow } from '@/lib/kalshi/model-picks-data'
import { rungLabel, summarizeBy, summarizeRecord, type RecordSummary } from '@/lib/kalshi/model-picks'
import { cents, MarketsHeader, MIN_RECORD_N, pct0, RecordLine, SideBadge, signedPct, TierBadge } from '@/components/ModelPicks'

export const dynamic = 'force-dynamic'

// Small groups are noise: grey out their rates instead of coloring them as results.
const roiClass = (v: number | null, n: number) =>
  n < MIN_RECORD_N ? 'text-[var(--text-tertiary)]' : (v ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'

function RecordTable({ title, rows }: { title: string; rows: { key: string; label: string; record: RecordSummary }[] }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">{title}</h2>
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <table className="w-full min-w-[360px] text-xs tabular-nums">
          <thead className="text-[var(--text-tertiary)]">
            <tr className="text-left">
              <th className="py-1 pr-3"></th><th className="pr-3">N</th><th className="pr-3">Record</th>
              <th className="pr-3">Win rate</th><th>ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label, record: r }) => (
              <tr key={key} className="border-t border-white/5">
                <td className="py-1.5 pr-3 font-semibold text-[var(--text-primary)]">{label}</td>
                <td className="pr-3">{r.n}</td>
                <td className="pr-3">{r.wins}-{r.n - r.wins}</td>
                <td className="pr-3">{r.winRate == null ? '—' : pct0(r.winRate)}</td>
                <td className={roiClass(r.roi, r.n)}>{r.roi == null ? '—' : signedPct(r.roi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-[var(--text-tertiary)]">Grey rates: fewer than {MIN_RECORD_N} graded, too few to judge.</p>
      </div>
    </section>
  )
}

export default async function MarketsPerformance() {
  const logged = await loadLoggedPicks(supabase)
    .catch((e: Error): ModelPickRow[] => { console.error('[markets/performance]', e.message); return [] })
  const graded = logged.filter((r) => r.result === 'yes' || r.result === 'no')
  const overall = summarizeRecord(graded)
  const byTier = summarizeBy(graded, (r) => r.tier).map((g) => ({ ...g, label: g.key }))
  const KIND_LABEL: Record<string, string> = { exact: 'Exact line', stretched: 'Stretched (paper)' }
  const byKind = summarizeBy(graded, (r) => r.kind ?? 'exact')
    .map((g) => ({ ...g, label: KIND_LABEL[g.key] ?? g.key }))
  const byStat = summarizeBy(graded, (r) => r.stat)
    .map((g) => ({ ...g, label: STAT_LABEL[g.key as MarketStat] ?? g.key }))
  const recent = graded.slice(0, 50)
  const pending = logged.filter((r) => r.result == null).length

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8">
      <MarketsHeader title="Performance">
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Kalshi model picks graded from Kalshi settlement, at the logged price plus fee. Voided markets are left out.
        </p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          Stretched picks price every Kalshi rung from the model&apos;s sportsbook line. They are paper-only until a
          pre-registered replay on last season passes.
        </p>
        <div className="mt-3"><RecordLine r={overall} /></div>
        {pending > 0 && (
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">
            {pending} logged pick{pending === 1 ? '' : 's'} awaiting settlement.
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">
          Is Kalshi priced right in general? See the{' '}
          <Link href="/markets/edge" className="font-semibold text-primary">calibration study</Link>.
        </p>
      </MarketsHeader>

      {overall.n === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-sm text-[var(--text-secondary)]">
            Nothing graded yet. Picks are logged 30 minutes before tip and graded overnight once Kalshi settles.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-3">
            <RecordTable title="By kind" rows={byKind} />
            <RecordTable title="By tier" rows={byTier} />
            <RecordTable title="By stat" rows={byStat} />
          </div>

          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
              Last {recent.length} graded
            </h2>
            <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <table className="w-full min-w-[640px] text-xs tabular-nums">
                <thead className="text-[var(--text-tertiary)]">
                  <tr className="text-left">
                    <th className="py-1 pr-3">Date</th><th className="pr-3">Player</th><th className="pr-3">Rung</th>
                    <th className="pr-3">Side</th><th className="pr-3">Price</th><th className="pr-3">Model</th>
                    <th className="pr-3">Tier</th><th className="pr-3">Result</th><th>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r) => {
                    const pnl = Number(r.pnl ?? 0)
                    return (
                      <tr key={r.id} className="border-t border-white/5">
                        <td className="py-1.5 pr-3 text-[var(--text-tertiary)]">{r.game_date}</td>
                        <td className="pr-3 font-semibold text-[var(--text-primary)]">{r.player}</td>
                        <td className="pr-3 text-[var(--text-secondary)]">{rungLabel(r.stat as MarketStat, r.strike)}</td>
                        <td className="pr-3"><SideBadge side={r.side} /></td>
                        <td className="pr-3">{cents(Number(r.price))}</td>
                        <td className="pr-3">{pct0(Number(r.model_p))}</td>
                        <td className="pr-3"><TierBadge tier={r.tier} /></td>
                        <td className={`pr-3 font-semibold ${r.won ? 'text-emerald-400' : 'text-red-400'}`}>
                          {r.won ? 'Won' : 'Lost'}
                        </td>
                        <td className={pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                          {pnl >= 0 ? '+' : '−'}{Math.abs(Math.round(pnl * 100))}¢
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
