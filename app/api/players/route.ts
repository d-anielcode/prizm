// Returns unique player names from today's upcoming scored props
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('props')
    .select('player_name')
    .not('confidence_score', 'is', null)
    .or(`commence_time.is.null,commence_time.gt.${now}`)

  if (error) return NextResponse.json([], { status: 500 })

  const names = [...new Set((data ?? []).map((r) => r.player_name as string))]
    .filter(Boolean)
    .sort()

  return NextResponse.json(names)
}
