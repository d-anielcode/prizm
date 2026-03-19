import { supabase } from '@/lib/supabase'
import { PropsTable } from '@/components/PropsTable'
import type { Prop } from '@/types'

export const revalidate = 0

async function getProps(): Promise<Prop[]> {
  const { data, error } = await supabase
    .from('props')
    .select('*')
    .not('confidence_score', 'is', null)
    .order('confidence_score', { ascending: false })
    .limit(500)

  if (error) {
    console.error('[page] Supabase error:', error.message)
    return []
  }
  return (data ?? []) as Prop[]
}

export default async function HomePage() {
  const props = await getProps()

  const high = props.filter((p) => p.confidence_label === 'HIGH').length
  const medium = props.filter((p) => p.confidence_label === 'MEDIUM').length
  const low = props.filter((p) => p.confidence_label === 'LOW').length

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Today&apos;s Props</h1>
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

      <PropsTable props={props} />
    </div>
  )
}
