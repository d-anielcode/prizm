import type { ReactNode } from 'react'
import Link from 'next/link'
import { normalizeTeamAbbr } from '@/lib/team-abbr'
import { rungLabel, type ModelPick, type RecordSummary } from '@/lib/kalshi/model-picks'
import type { MarketStat } from '@/lib/kalshi/ladder'

export const cents = (p: number) => `${Math.round(p * 100)}¢`
export const pct0 = (p: number) => `${Math.round(p * 100)}%`
export const pts = (e: number) => `+${(e * 100).toFixed(1)} pts`
export const signedPct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`
export const team = (t: string) => normalizeTeamAbbr(t) ?? t

const TIER_STYLE: Record<string, string> = {
  LOCK: 'bg-[#00D68F]/15 text-[#00D68F] border-[#00D68F]/25',
  PLAY: 'bg-[#FFB800]/15 text-[#FFB800] border-[#FFB800]/25',
}

export function TierBadge({ tier }: { tier: string }) {
  return (
    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${TIER_STYLE[tier] ?? 'border-white/10 text-[var(--text-tertiary)]'}`}>
      {tier}
    </span>
  )
}

export function SideBadge({ side }: { side: 'yes' | 'no' }) {
  return (
    <span className={`text-xs font-bold ${side === 'yes' ? 'text-emerald-400' : 'text-red-400'}`}>
      {side.toUpperCase()}
    </span>
  )
}

export function ModelPicksDisclosure() {
  return (
    <p className="mt-3 rounded-lg border border-[#FFB800]/20 bg-[#FFB800]/[0.06] px-3 py-2 text-xs text-[var(--text-secondary)]">
      Model picks: Prizm&apos;s sportsbook model applied to Kalshi prices. On held-out sportsbook data its LOCK/PLAY
      picks lost about 5% at real odds; the record below tracks how it does on Kalshi.
    </p>
  )
}

export function RecordLine({ r }: { r: RecordSummary }) {
  if (!r.n) return <p className="text-sm text-[var(--text-tertiary)]">No graded Kalshi model picks yet.</p>
  return (
    <p className="text-sm text-[var(--text-secondary)] tabular-nums">
      Kalshi record: <span className="font-semibold text-[var(--text-primary)]">{r.wins}-{r.n - r.wins}</span>
      {' · '}{pct0(r.winRate ?? 0)} win rate
      {' · '}ROI <span className={(r.roi ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}>{signedPct(r.roi ?? 0)}</span>
      {' '}on {r.n} graded
    </p>
  )
}

export function PickCard({ p }: { p: ModelPick }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-[var(--text-primary)]">{p.player}</p>
          <p className="text-xs text-[var(--text-tertiary)]">{team(p.away)} @ {team(p.home)}</p>
        </div>
        <TierBadge tier={p.tier} />
      </div>
      <p className="mt-3 text-sm text-[var(--text-primary)]">
        <SideBadge side={p.side} /> <span className="font-semibold">{rungLabel(p.stat as MarketStat, p.strike)}</span>
        <span className="text-[var(--text-tertiary)]"> at {cents(p.price)}</span>
      </p>
      <p className="mt-1 text-xs text-[var(--text-secondary)] tabular-nums">
        Model {pct0(p.modelP)} · Edge <span className="text-emerald-400">{pts(p.edge)}</span>
      </p>
    </div>
  )
}

export function PicksTable({ picks }: { picks: ModelPick[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs tabular-nums">
        <thead className="text-[var(--text-tertiary)]">
          <tr className="text-left">
            <th className="py-1 pr-3">Player</th><th className="pr-3">Rung</th><th className="pr-3">Side</th>
            <th className="pr-3">Price</th><th className="pr-3">Model</th><th className="pr-3">Edge</th><th>Tier</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((p) => (
            <tr key={`${p.ticker}|${p.side}`} className="border-t border-white/5">
              <td className="py-1.5 pr-3 font-semibold text-[var(--text-primary)]">{p.player}</td>
              <td className="pr-3 text-[var(--text-secondary)]">{rungLabel(p.stat as MarketStat, p.strike)}</td>
              <td className="pr-3"><SideBadge side={p.side} /></td>
              <td className="pr-3">{cents(p.price)}</td>
              <td className="pr-3">{pct0(p.modelP)}</td>
              <td className="pr-3 text-emerald-400">{pts(p.edge)}</td>
              <td><TierBadge tier={p.tier} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MarketsHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header>
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
      <h1 className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{title}</h1>
      {children}
    </header>
  )
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="text-sm font-semibold text-primary">{children}</Link>
}
