import { supabase } from '@/lib/supabase'
import { CalibrationChart } from '@/components/CalibrationChart'
import { pocketLabel, STATUS_LABEL, type CalibrationRow, type PocketRow } from '@/lib/kalshi/edge'

export const revalidate = 300

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}%`

export default async function MarketsEdge() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [{ data: cal }, { data: pockets }, { data: paper }] = await Promise.all([
    supabase.from('kalshi_calibration').select('season, band, n, mean_ask, mean_mid, yes_rate'),
    supabase.from('kalshi_pockets').select('id, status, disc_n, disc_roi, disc_p, conf_n, conf_roi, fwd_n, fwd_roi'),
    supabase.from('kalshi_pocket_trades').select('pocket_id, ticker, side, price').eq('game_date', today).order('ticker'),
  ])
  const all = (pockets ?? []) as PocketRow[]
  const shown = all.filter((p) => p.status !== 'rejected').sort((a, b) => Number(b.disc_roi) - Number(a.disc_roi))
  const rejected = all.length - shown.length

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-10">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
        <h1 className="mt-1 text-2xl font-bold text-[var(--text-primary)]">Edge</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Is Kalshi priced right? Every settled player prop since Nov 2025, priced just before tip. Pockets must pass
          a pre-registered test on last season, hold up this season, then win in forward paper trading.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Calibration</h2>
        {cal?.length ? <CalibrationChart rows={cal as CalibrationRow[]} /> :
          <p className="text-sm text-[var(--text-secondary)]">The study has not run yet.</p>}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Pockets</h2>
        {all.length > 0 && <p className="mb-3 text-xs text-[var(--text-tertiary)]">{rejected} of {all.length} tested pockets rejected.</p>}
        {all.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">The study has not run yet.</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">No pocket passed the pre-registered test.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs tabular-nums">
              <thead className="text-left text-[var(--text-tertiary)]">
                <tr><th className="py-1 pr-3">Pocket</th><th className="pr-3">2025-26</th><th className="pr-3">2026-27</th><th className="pr-3">Forward</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 font-semibold text-[var(--text-primary)]">{pocketLabel(p.id)}</td>
                    <td className="pr-3">{pct(p.disc_roi)} <span className="text-[var(--text-tertiary)]">n={p.disc_n}</span></td>
                    <td className="pr-3">{pct(p.conf_roi)} <span className="text-[var(--text-tertiary)]">n={p.conf_n}</span></td>
                    <td className="pr-3">{p.fwd_n ? <>{pct(p.fwd_roi)} <span className="text-[var(--text-tertiary)]">n={p.fwd_n}</span></> : '—'}</td>
                    <td>{STATUS_LABEL[p.status] ?? p.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Today&apos;s paper rungs</h2>
        {paper?.length ? (
          <ul className="space-y-1 text-xs">
            {paper.map((t) => (
              <li key={`${t.pocket_id}|${t.ticker}|${t.side}`} className="flex flex-wrap gap-x-3">
                <span className="rounded bg-white/10 px-1.5 text-[10px] font-semibold uppercase">paper</span>
                <span className="font-semibold text-[var(--text-primary)]">{t.ticker}</span>
                <span>{String(t.side).toUpperCase()} at {Math.round(Number(t.price) * 100)}¢</span>
                <span className="text-[var(--text-tertiary)]">{pocketLabel(t.pocket_id)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            {shown.some((p) => p.status === 'confirmed' || p.status === 'live')
              ? 'Paper rungs are logged in the 30 minutes before each tip.'
              : 'No pocket has confirmed yet, so nothing is being paper traded.'}
          </p>
        )}
      </section>
    </div>
  )
}
