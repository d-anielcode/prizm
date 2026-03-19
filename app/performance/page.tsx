import { supabase } from '@/lib/supabase'

export const revalidate = 0

interface ResultRow {
  date: string
  confidence_label: string
  total: number
  hits: number
  hit_rate: number
}

const TIER_COLORS = {
  HIGH:   { bar: 'bg-emerald-500', text: 'text-emerald-400', badge: 'bg-emerald-500/12 border-emerald-500/30 text-emerald-400', glow: 'shadow-[0_0_12px_rgba(16,185,129,0.2)]' },
  MEDIUM: { bar: 'bg-[#e8a820]',   text: 'text-[#f0c060]',  badge: 'bg-[#e8a820]/12 border-[#e8a820]/30 text-[#f0c060]',      glow: 'shadow-[0_0_12px_rgba(232,168,32,0.2)]' },
  LOW:    { bar: 'bg-red-500',      text: 'text-red-400',    badge: 'bg-red-500/12 border-red-500/30 text-red-400',             glow: '' },
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const target    = new Date(dateStr + 'T00:00:00')
  if (target.getTime() === yesterday.getTime()) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function HitBar({ rate, colorClass }: { rate: number; colorClass: string }) {
  const pct = Math.round(rate * 100)
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-2 bg-white/[0.06] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-black w-10 text-right tabular-nums">{pct}%</span>
    </div>
  )
}

async function getData() {
  const { data } = await supabase
    .from('prop_results')
    .select('*')
    .order('date', { ascending: false })
    .limit(56) // 14 days × 4 labels
  return (data ?? []) as ResultRow[]
}

export default async function PerformancePage() {
  const results = await getData()

  // Group by date
  const byDate = new Map<string, Record<string, ResultRow>>()
  const allByDate = new Map<string, ResultRow>()
  for (const r of results) {
    if (r.confidence_label === 'ALL') {
      allByDate.set(r.date, r)
    } else {
      if (!byDate.has(r.date)) byDate.set(r.date, {})
      byDate.get(r.date)![r.confidence_label] = r
    }
  }

  const sortedDates = [...byDate.keys()].sort((a, b) => b.localeCompare(a))

  // Compute rolling averages across all days
  const rollingTotals: Record<string, { total: number; hits: number }> = {
    HIGH: { total: 0, hits: 0 }, MEDIUM: { total: 0, hits: 0 }, LOW: { total: 0, hits: 0 }, ALL: { total: 0, hits: 0 },
  }
  for (const r of results) {
    if (rollingTotals[r.confidence_label]) {
      rollingTotals[r.confidence_label].total += r.total
      rollingTotals[r.confidence_label].hits  += r.hits
    }
  }

  const hasData = sortedDates.length > 0

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 flex flex-col gap-10">

      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-black text-white tracking-tight">Model Performance</h1>
        <p className="text-white/35 text-sm">
          How many of Prizm&apos;s confidence picks actually hit — tracked daily.
        </p>
      </div>

      {!hasData ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-16 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
            <svg className="w-7 h-7 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <p className="text-white/50 font-semibold">No results yet</p>
            <p className="text-white/25 text-sm mt-1 max-w-sm">
              Results are calculated automatically each morning after games complete.
              Check back after tonight&apos;s games finish.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* ── Overall rolling stats ── */}
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-white/35 uppercase tracking-widest">
              All-time ({sortedDates.length} days tracked)
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {(['HIGH', 'MEDIUM', 'LOW', 'ALL'] as const).map((label) => {
                const t = rollingTotals[label]
                if (!t || t.total === 0) return null
                const pct = Math.round((t.hits / t.total) * 100)
                const c = label !== 'ALL' ? TIER_COLORS[label] : null
                return (
                  <div
                    key={label}
                    className={`rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-1 ${c?.glow ?? ''}`}
                  >
                    <span className={`text-[10px] font-black uppercase tracking-wider ${c?.text ?? 'text-white/40'}`}>
                      {label === 'ALL' ? 'Overall' : label}
                    </span>
                    <div className="flex items-baseline gap-1.5 mt-1">
                      <span className={`text-3xl font-black ${c?.text ?? 'text-white'}`}>{pct}%</span>
                    </div>
                    <span className="text-xs text-white/25">{t.hits}/{t.total} props hit</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Per-day breakdown ── */}
          <div className="flex flex-col gap-4">
            <p className="text-[11px] text-white/35 uppercase tracking-widest">Daily Breakdown</p>

            {sortedDates.map((date) => {
              const tiers  = byDate.get(date) ?? {}
              const allRow = allByDate.get(date)
              const overallPct = allRow ? Math.round(allRow.hit_rate * 100) : null

              return (
                <div key={date} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                  <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/30 to-transparent" />
                  <div className="p-5 flex flex-col gap-4">
                    {/* Date header */}
                    <div className="flex items-center justify-between">
                      <p className="font-bold text-white/70">{formatDate(date)}</p>
                      {overallPct !== null && (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-white/30">Overall</span>
                          <span className={`text-sm font-black ${overallPct >= 65 ? 'text-emerald-400' : overallPct >= 55 ? 'text-[#f0c060]' : 'text-red-400'}`}>
                            {overallPct}%
                          </span>
                          <span className="text-xs text-white/25">
                            {allRow!.hits}/{allRow!.total}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Per-tier bars */}
                    <div className="flex flex-col gap-3">
                      {(['HIGH', 'MEDIUM', 'LOW'] as const).map((label) => {
                        const row = tiers[label]
                        if (!row) return null
                        const c = TIER_COLORS[label]
                        return (
                          <div key={label} className="flex items-center gap-3">
                            <span className={`text-[10px] font-black w-14 shrink-0 px-1.5 py-0.5 rounded border text-center ${c.badge}`}>
                              {label}
                            </span>
                            <div className="flex-1">
                              <HitBar rate={row.hit_rate} colorClass={c.bar} />
                            </div>
                            <span className="text-xs text-white/25 shrink-0 w-14 text-right tabular-nums">
                              {row.hits}/{row.total}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
