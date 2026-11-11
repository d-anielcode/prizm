import { supabase } from '@/lib/supabase'

export const revalidate = 60

type Run = { run_id: string; phase: string; step: string; game_date: string | null; source: string
  status: 'running' | 'ok' | 'failed' | 'skipped'; started_at: string; duration_ms: number | null; error: string | null }

const COLORS: Record<Run['status'], string> = {
  ok: 'text-emerald-400', failed: 'text-red-400', skipped: 'text-white/40', running: 'text-[#FFB800]' }

async function newest(table: string, col: string): Promise<string | null> {
  const { data } = await supabase.from(table).select(col).order(col, { ascending: false }).limit(1)
  const row = (data?.[0] ?? null) as Record<string, string> | null
  return row ? row[col] : null
}

async function loadStatus() {
  const { data } = await supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(400)
  const now = Date.now()
  const days = [...Array(7)].map((_, i) => new Date(now - i * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
  const fresh = await Promise.all([
    newest('player_game_logs', 'game_date'), newest('prop_grades', 'game_date'), newest('props', 'cached_at'),
    newest('team_defense_stats', 'fetched_at'), newest('kalshi_paper_trades', 'scanned_at')])
  return { runs: (data ?? []) as Run[], days, fresh }
}

export default async function StatusPage() {
  const { runs, days, fresh } = await loadStatus()
  const latestRunByPhase = new Map<string, string>()
  for (const r of runs) if (!latestRunByPhase.has(r.phase)) latestRunByPhase.set(r.phase, r.run_id)
  const phases = ['overnight', 'midday', 'pretip', 'weekly', 'pc']
  const cell = (phase: string, day: string) => {
    const rs = runs.filter((r) => r.phase === phase && (r.started_at.slice(0, 10) === day || r.game_date === day) && r.step !== 'gate')
    if (rs.length === 0) return '·'
    return rs.some((r) => r.status === 'failed') ? '✗' : rs.some((r) => r.status === 'ok') ? '✓' : '–'
  }
  const freshLabels = ['Newest game log', 'Newest grade', 'Props refreshed', 'Defense data', 'Kalshi scan']

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
      <h1 className="text-3xl font-bold">Pipeline status</h1>
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
        {freshLabels.map((l, i) => (
          <div key={l} className="rounded-lg border border-white/10 px-3 py-2">
            <div className="text-white/40">{l}</div><div className="font-mono">{fresh[i]?.slice(0, 16).replace('T', ' ') ?? '—'}</div>
          </div>))}
      </section>
      <section>
        <h2 className="text-sm uppercase tracking-wider text-white/40 mb-2">Last 7 days</h2>
        <table className="text-sm font-mono"><thead><tr><th className="text-left pr-4">phase</th>
          {days.map((d) => <th key={d} className="px-2 text-white/40">{d.slice(5)}</th>)}</tr></thead>
          <tbody>{phases.map((p) => <tr key={p}><td className="pr-4">{p}</td>
            {days.map((d) => <td key={d} className="px-2 text-center">{cell(p, d)}</td>)}</tr>)}</tbody></table>
      </section>
      {[...latestRunByPhase.entries()].map(([phase, runId]) => {
        const steps = runs.filter((r) => r.run_id === runId).reverse()
        return (
          <section key={phase}>
            <h2 className="text-sm uppercase tracking-wider text-white/40 mb-2">
              {phase} · {new Date(steps[0]?.started_at ?? '').toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</h2>
            <table className="w-full text-sm"><tbody>{steps.map((s) => (
              <tr key={s.step + s.started_at} className="border-t border-white/5">
                <td className="py-1 pr-3 font-mono">{s.step}</td><td className={`pr-3 ${COLORS[s.status]}`}>{s.status}</td>
                <td className="pr-3 text-white/40">{s.game_date}</td>
                <td className="pr-3 text-white/40">{s.duration_ms != null ? `${(s.duration_ms / 1000).toFixed(1)}s` : ''}</td>
                <td className="text-red-400/80 text-xs">{s.error ?? ''}</td></tr>))}</tbody></table>
          </section>)
      })}
    </main>
  )
}
