import { STAT_LABEL, type MarketStat } from '@/lib/kalshi/ladder'

export interface CalibrationRow {
  season: string; band: string; n: number; mean_ask: number; yes_rate: number
  /** Mean (bid+ask)/2 over two-sided quotes in the band; null when no row had a bid. */
  mean_mid?: number | null
}
export interface PocketRow {
  id: string; status: string
  disc_n: number; disc_roi: number; disc_p: number
  conf_n: number; conf_roi: number; fwd_n: number; fwd_roi: number
}

export const STATUS_LABEL: Record<string, string> = {
  rejected: 'Rejected', discovery_pass: 'Waiting on 2026-27 sample', failed_confirmation: 'Failed 2026-27',
  confirmed: 'Paper trading', failed_forward: 'Failed forward test', live: 'Passed forward test',
}

const cents = (s: string) => `${Math.round(parseFloat(s) * 100)}`

export function pocketLabel(id: string): string {
  const [side, ...parts] = id.split('|')
  const out = [side.toUpperCase()]
  for (const p of parts) {
    const [k, v] = p.split(':')
    if (k === 'band') { const [lo, hi] = v.split('-'); out.push(`${cents(lo)}–${cents(hi)}¢`) }
    else if (k === 'stat') out.push(STAT_LABEL[v as MarketStat] ?? v)
    else if (k === 'pos') out.push(`${v} rung`)
    else if (k === 'spread') out.push(`spread ${v}¢`)
    else if (k === 'vol') out.push(`volume ${v}`)
  }
  return out.join(' · ')
}

/** Plot coordinates in a w x h box with `pad` margin; x = mean mid price (falls back to the
 *  mean ask when the band has no two-sided quote), y = realized YES rate. */
export function chartPoints(rows: CalibrationRow[], w: number, h: number, pad: number) {
  return rows.map((r) => {
    const price = r.mean_mid != null ? Number(r.mean_mid) : Number(r.mean_ask)
    return {
      ...r,
      price,
      x: pad + price * (w - 2 * pad),
      y: pad + (1 - Number(r.yes_rate)) * (h - 2 * pad),
    }
  })
}
