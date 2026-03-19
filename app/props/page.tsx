import { supabase } from '@/lib/supabase'
import { PropsTable } from '@/components/PropsTable'
import type { Prop } from '@/types'

export const revalidate = 0

function deduplicateProps(props: Prop[]): Prop[] {
  const best = new Map<string, Prop>()
  for (const prop of props) {
    const key = `${prop.player_name}|${prop.stat_type}|${prop.line}`
    const existing = best.get(key)
    if (!existing || (prop.confidence_score ?? 0) > (existing.confidence_score ?? 0)) {
      best.set(key, prop)
    }
  }
  return [...best.values()].sort(
    (a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0),
  )
}

async function getProps(): Promise<Prop[]> {
  const now = new Date().toISOString()
  const allRows: Prop[] = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('props')
      .select('*')
      .not('confidence_score', 'is', null)
      .or(`commence_time.is.null,commence_time.gt.${now}`)
      .order('confidence_score', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[props] Supabase error:', error.message)
      break
    }
    if (!data || data.length === 0) break
    allRows.push(...(data as Prop[]))
    if (data.length < PAGE) break
    from += PAGE
  }
  return deduplicateProps(allRows)
}

export default async function PropsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>
}) {
  const { search } = await searchParams
  const props = await getProps()

  const high = props.filter((p) => p.confidence_label === 'HIGH').length
  const medium = props.filter((p) => p.confidence_label === 'MEDIUM').length
  const low = props.filter((p) => p.confidence_label === 'LOW').length

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">All Props</h1>
        <p className="text-white/40 text-sm mt-1">
          {props.length} props scored · sorted by confidence
        </p>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
          <span className="text-green-400 font-semibold">{high}</span>
          <span className="text-white/40 ml-1.5">High confidence</span>
        </div>
        <div className="px-4 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm">
          <span className="text-yellow-400 font-semibold">{medium}</span>
          <span className="text-white/40 ml-1.5">Medium confidence</span>
        </div>
        <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
          <span className="text-red-400 font-semibold">{low}</span>
          <span className="text-white/40 ml-1.5">Low confidence</span>
        </div>
      </div>

      <PropsTable props={props} initialSearch={search ?? ''} />
    </div>
  )
}
