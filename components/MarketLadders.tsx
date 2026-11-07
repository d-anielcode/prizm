import { breakEven, STAT_LABEL, type GameLadders, type HitRate, type MarketStat } from '@/lib/kalshi/ladder'
import { normalizeTeamAbbr } from '@/lib/team-abbr'

export type RungRates = { l5: HitRate; l10: HitRate; season: HitRate } | null
export type RatesFor = (player: string, stat: MarketStat, strike: number) => RungRates

const cents = (p: number | null) => (p == null ? '—' : `${Math.round(p * 100)}¢`)
const pct = (p: number) => `${Math.round(p * 100)}%`
const frac = (h: HitRate) => (h.games ? `${h.hits}/${h.games}` : '—')

function rungLabel(stat: MarketStat, strike: number) {
  return stat === 'double_double' ? 'DD' : stat === 'triple_double' ? 'TD' : `${strike}+`
}

export function MarketLadders({ games, ratesFor }: { games: GameLadders[]; ratesFor: RatesFor }) {
  return (
    <div className="space-y-8">
      {games.map((g) => (
        <section key={g.key}>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
            {normalizeTeamAbbr(g.away) ?? g.away} @ {normalizeTeamAbbr(g.home) ?? g.home}
          </h2>
          <div className="space-y-4">
            {g.players.map((p) => (
              <div key={p.player} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <h3 className="font-semibold text-[var(--text-primary)]">{p.player}</h3>
                {p.stats.map((s) => (
                  <div key={s.stat} className="mt-3 overflow-x-auto">
                    <p className="mb-1 text-xs font-semibold text-[var(--text-secondary)]">{STAT_LABEL[s.stat]}</p>
                    <table className="w-full min-w-[520px] text-xs tabular-nums">
                      <thead className="text-[var(--text-tertiary)]">
                        <tr className="text-left">
                          <th className="py-1 pr-3">Rung</th><th className="pr-3">Bid / Ask</th>
                          <th className="pr-3">Break-even</th><th className="pr-3">Move</th>
                          <th className="pr-3">L5</th><th className="pr-3">L10</th><th>Season</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.rungs.map((r) => {
                          const rates = ratesFor(p.player, s.stat, r.strike)
                          const wide = r.yes_bid == null || r.yes_ask == null || Math.round((r.yes_ask - r.yes_bid) * 100) > 10
                          const move = r.yes_ask != null && r.first_yes_ask != null ? r.yes_ask - r.first_yes_ask : 0
                          return (
                            <tr key={r.ticker} className={`border-t border-white/5 ${wide ? 'opacity-40' : ''}`}>
                              <td className="py-1 pr-3 font-semibold text-[var(--text-primary)]">{rungLabel(s.stat, r.strike)}</td>
                              <td className="pr-3">{cents(r.yes_bid)} / {cents(r.yes_ask)}</td>
                              <td className="pr-3">{r.yes_ask == null ? '—' : pct(breakEven(r.yes_ask))}</td>
                              <td className={`pr-3 ${move > 0 ? 'text-emerald-400' : move < 0 ? 'text-red-400' : 'text-[var(--text-tertiary)]'}`}>
                                {move > 0 ? '▲' : move < 0 ? '▼' : '·'}{move ? ` ${Math.abs(Math.round(move * 100))}¢` : ''}
                              </td>
                              {rates ? (
                                <>
                                  <td className="pr-3">{frac(rates.l5)}</td>
                                  <td className="pr-3">{frac(rates.l10)}</td>
                                  <td>{frac(rates.season)}{rates.season.games ? ` (${pct(rates.season.hits / rates.season.games)})` : ''}</td>
                                </>
                              ) : (
                                <td colSpan={3} className="text-[var(--text-tertiary)]">no history</td>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
