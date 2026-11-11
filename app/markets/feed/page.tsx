import { supabase } from '@/lib/supabase'
import { loadTodayPicks } from '@/lib/kalshi/model-picks-data'
import { groupPicksByGame, type ModelPick } from '@/lib/kalshi/model-picks'
import { MarketsHeader, ModelPicksDisclosure, PicksTable, team } from '@/components/ModelPicks'

export const dynamic = 'force-dynamic'

export default async function MarketsFeed() {
  const picks = await loadTodayPicks(supabase).then((r) => r.picks)
    .catch((e: Error): ModelPick[] => { console.error('[markets/feed]', e.message); return [] })
  const games = groupPicksByGame(picks)

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <MarketsHeader title="Model picks">
        <ModelPicksDisclosure />
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">
          Price is the current ask for that side (NO = 100¢ minus the YES bid). Edge is the model&apos;s probability minus
          price and Kalshi&apos;s fee. Picks are logged to the record 30 minutes before tip.
        </p>
      </MarketsHeader>

      <div className="mt-6 space-y-8">
        {games.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <p className="text-sm text-[var(--text-primary)]">No model picks match Kalshi rungs yet today.</p>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              A pick needs a LOCK or PLAY sportsbook line that maps exactly onto a Kalshi rung (an over 24.5 is the 25+
              rung), a tight two-sided market, and a price below the model&apos;s calibrated probability.
            </p>
          </div>
        ) : games.map((g) => (
          <section key={g.key}>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
              {team(g.away)} @ {team(g.home)}
            </h2>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <PicksTable picks={g.picks} />
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
