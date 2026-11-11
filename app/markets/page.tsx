import { supabase } from '@/lib/supabase'
import { loadLoggedPicks, loadTodayPicks, type ModelPickRow } from '@/lib/kalshi/model-picks-data'
import { summarizeRecord, type ModelPick } from '@/lib/kalshi/model-picks'
import { MarketsHeader, ModelPicksDisclosure, PickCard, RecordLine, TextLink } from '@/components/ModelPicks'

export const dynamic = 'force-dynamic'

export default async function MarketsHome() {
  const [picks, logged] = await Promise.all([
    loadTodayPicks(supabase).then((r) => r.picks)
      .catch((e: Error): ModelPick[] => { console.error('[markets] picks', e.message); return [] }),
    loadLoggedPicks(supabase)
      .catch((e: Error): ModelPickRow[] => { console.error('[markets] record', e.message); return [] }),
  ])
  const top = picks.slice(0, 5)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <MarketsHeader title="Today on Kalshi">
        <ModelPicksDisclosure />
      </MarketsHeader>

      <div className="mt-4"><RecordLine r={summarizeRecord(logged)} /></div>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">Top model picks</h2>
        {top.length === 0 ? (
          <p className="text-sm text-[var(--text-secondary)]">
            No model picks match Kalshi rungs yet today. A pick needs a LOCK or PLAY sportsbook line that lands exactly on a
            Kalshi rung at a price below the model&apos;s number.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {top.map((p) => <PickCard key={`${p.ticker}|${p.side}`} p={p} />)}
          </div>
        )}
      </section>

      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
        <TextLink href="/markets/feed">All of today&apos;s picks →</TextLink>
        <TextLink href="/markets/props">Kalshi ladders →</TextLink>
        <TextLink href="/markets/performance">Graded record →</TextLink>
      </div>
    </div>
  )
}
