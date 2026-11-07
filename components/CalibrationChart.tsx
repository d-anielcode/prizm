import { chartPoints, type CalibrationRow } from '@/lib/kalshi/edge'

const W = 520, H = 320, PAD = 36
const COLORS: Record<string, string> = { '2025-26': '#8b5cf6', '2026-27': '#22c55e' }

export function CalibrationChart({ rows }: { rows: CalibrationRow[] }) {
  const pts = chartPoints(rows, W, H, PAD)
  const seasons = [...new Set(rows.map((r) => r.season))].sort()
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const sx = (v: number) => PAD + v * (W - 2 * PAD)
  const sy = (v: number) => PAD + (1 - v) * (H - 2 * PAD)
  return (
    <figure className="w-full max-w-[560px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
        aria-label="Kalshi pre-tip YES price vs how often YES actually hit">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(0)} x2={sx(1)} y1={sy(t)} y2={sy(t)} stroke="currentColor" strokeOpacity={0.08} />
            <text x={PAD - 6} y={sy(t) + 4} fontSize={10} textAnchor="end" fill="currentColor" opacity={0.5}>{Math.round(t * 100)}%</text>
            <text x={sx(t)} y={H - PAD + 16} fontSize={10} textAnchor="middle" fill="currentColor" opacity={0.5}>{Math.round(t * 100)}¢</text>
          </g>
        ))}
        <line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="4 4" />
        {seasons.map((s) => {
          const line = pts.filter((p) => p.season === s).sort((a, b) => a.x - b.x)
          return (
            <g key={s}>
              <polyline points={line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={COLORS[s] ?? '#999'} strokeWidth={2} />
              {line.map((p) => (
                <circle key={p.band} cx={p.x} cy={p.y} r={3.5} fill={COLORS[s] ?? '#999'}>
                  <title>{`${s} ${p.band}: price ${Math.round(Number(p.mean_ask) * 100)}¢, hit ${Math.round(Number(p.yes_rate) * 100)}% (n=${p.n})`}</title>
                </circle>
              ))}
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-2 flex gap-4 text-xs text-[var(--text-tertiary)]">
        {seasons.map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: COLORS[s] ?? '#999' }} />{s}
          </span>
        ))}
        <span>Dashed line = priced exactly right</span>
      </figcaption>
    </figure>
  )
}
