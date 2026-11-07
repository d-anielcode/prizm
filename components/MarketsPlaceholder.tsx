import Link from 'next/link'

export function MarketsPlaceholder({ title, phase, blurb }: { title: string; phase: number; blurb: string }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-tertiary)]">Prediction Markets</p>
      <h1 className="mt-2 text-2xl font-bold text-[var(--text-primary)]">{title}</h1>
      <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-5">
        <p className="text-sm text-[var(--text-secondary)]">{blurb}</p>
        <p className="mt-3 text-xs text-[var(--text-tertiary)]">Coming in phase {phase}.</p>
      </div>
      <Link href="/markets/props" className="mt-6 inline-block text-sm font-semibold text-primary">
        See today&apos;s Kalshi ladders →
      </Link>
    </div>
  )
}
