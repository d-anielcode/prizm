import { supabase } from '@/lib/supabase'
import { PropsTable } from '@/components/PropsTable'
import type { AltLine, Prop, PropWithAlts } from '@/types'

export const dynamic = 'force-dynamic'

async function getProps(): Promise<PropWithAlts[]> {
  const now = new Date().toISOString()

  // Fetch main props
  const allRows: Prop[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('props')
      .select('*')
      .or(`commence_time.is.null,commence_time.gt.${now}`)
      .order('confidence_score', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1)
    if (error) { console.error('[props] Supabase error:', error.message); break }
    if (!data || data.length === 0) break
    allRows.push(...(data as Prop[]))
    if (data.length < PAGE) break
    from += PAGE
  }

  if (allRows.length === 0) return []

  // Deduplicate: same player + stat + line → keep highest confidence
  const bestMap = new Map<string, Prop>()
  for (const p of allRows) {
    const key = `${p.player_name}|${p.stat_type}|${p.line}|${p.direction}`
    const existing = bestMap.get(key)
    if (!existing || (p.confidence_score ?? 0) > (existing.confidence_score ?? 0)) {
      bestMap.set(key, p)
    }
  }
  const deduped = [...bestMap.values()]

  // Sort by tier first (LOCK > PLAY > LEAN > FADE), then by score within tier
  const TIER_ORDER: Record<string, number> = { LOCK: 0, PLAY: 1, LEAN: 2, FADE: 3 }
  deduped.sort((a, b) => {
    const ta = TIER_ORDER[a.confidence_label ?? ''] ?? 4
    const tb = TIER_ORDER[b.confidence_label ?? ''] ?? 4
    if (ta !== tb) return ta - tb
    return (b.confidence_score ?? 0) - (a.confidence_score ?? 0)
  })

  // Fetch alt lines for these games — paginated to avoid 1000-row Supabase default limit
  const gameIds = [...new Set(allRows.map((p) => p.game_id).filter(Boolean))]
  const altRows: (AltLine & { player_name: string; stat_type: string; game_id: string })[] = []
  let altFrom = 0
  const ALT_PAGE = 1000
  while (true) {
    const { data: altPage } = await supabase
      .from('prop_alts')
      .select('*')
      .in('game_id', gameIds)
      .range(altFrom, altFrom + ALT_PAGE - 1)
    if (!altPage || altPage.length === 0) break
    altRows.push(...(altPage as typeof altRows))
    if (altPage.length < ALT_PAGE) break
    altFrom += ALT_PAGE
  }

  return deduped.map((p) => ({
    ...p,
    altLines: altRows
      .filter((a) => a.player_name === p.player_name && a.stat_type === p.stat_type && a.direction === p.direction)
      .sort((a, b) => a.line - b.line),
  }))
}

export default async function PropsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>
}) {
  const { search } = await searchParams
  const props = await getProps()

  const lock = props.filter((p) => p.confidence_label === 'LOCK').length
  const play = props.filter((p) => p.confidence_label === 'PLAY').length
  const lean = props.filter((p) => p.confidence_label === 'LEAN').length
  const fade = props.filter((p) => p.confidence_label === 'FADE').length

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">All Props</h1>
        <p className="text-[var(--text-secondary)] text-sm mt-1">
          {props.length} props scored
        </p>
      </div>

      <div className="grid grid-cols-4 sm:flex gap-3">
        <div className="px-3 sm:px-4 py-2 rounded-lg bg-[#00D68F]/10 border border-[#00D68F]/20 text-sm text-center sm:text-left">
          <span className="text-[#00D68F] font-semibold">{lock}</span>
          <span className="text-[var(--text-secondary)] ml-1 sm:ml-1.5 text-xs sm:text-sm">Lock</span>
        </div>
        <div className="px-3 sm:px-4 py-2 rounded-lg bg-[#FFB800]/10 border border-[#FFB800]/20 text-sm text-center sm:text-left">
          <span className="text-[#FFB800] font-semibold">{play}</span>
          <span className="text-[var(--text-secondary)] ml-1 sm:ml-1.5 text-xs sm:text-sm">Play</span>
        </div>
        <div className="px-3 sm:px-4 py-2 rounded-lg bg-[#3B82F6]/10 border border-[#3B82F6]/20 text-sm text-center sm:text-left">
          <span className="text-[#3B82F6] font-semibold">{lean}</span>
          <span className="text-[var(--text-secondary)] ml-1 sm:ml-1.5 text-xs sm:text-sm">Lean</span>
        </div>
        <div className="px-3 sm:px-4 py-2 rounded-lg bg-[#FF4757]/10 border border-[#FF4757]/20 text-sm text-center sm:text-left">
          <span className="text-[#FF4757] font-semibold">{fade}</span>
          <span className="text-[var(--text-secondary)] ml-1 sm:ml-1.5 text-xs sm:text-sm">Fade</span>
        </div>
      </div>

      <PropsTable props={props} initialSearch={search ?? ''} />
    </div>
  )
}
