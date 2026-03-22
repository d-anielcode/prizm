// /api/feed — CRUD for curated parlays posted to the feed
//
// GET  — returns active parlays (most recent first, last 30 days)
// POST — creates a new curated parlay
//
// Body for POST:
// {
//   title:         string           // e.g. "Tonight's SGP — LAL @ GSW"
//   description?:  string           // optional context / reasoning
//   parlay_type:   'sgp' | 'multi'  // same-game or cross-game
//   game_date:     string           // YYYY-MM-DD
//   est_multiplier?: number         // estimated payout multiplier
//   legs: Array<{
//     player_name:       string
//     team:              string
//     stat_type:         string
//     line:              number
//     direction:         'over' | 'under'
//     odds?:             number
//     confidence_label?: string
//     confidence_score?: number
//   }>
// }

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
)

export async function GET() {
  const { data, error } = await supabase
    .from('curated_parlays')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    // Table may not exist yet — return empty rather than crashing
    if (error.code === '42P01') return NextResponse.json({ parlays: [] })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ parlays: data ?? [] })
}

export async function POST(req: Request) {
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { title, description, parlay_type, game_date, est_multiplier, legs } = body as Record<string, unknown>

  if (!title || !legs || !game_date) {
    return NextResponse.json({ error: 'title, legs, and game_date are required' }, { status: 400 })
  }

  const { data, error } = await adminClient
    .from('curated_parlays')
    .insert({
      title,
      description: description ?? null,
      parlay_type:    parlay_type ?? 'sgp',
      game_date,
      est_multiplier: est_multiplier ?? null,
      legs,
      active: true,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ parlay: data }, { status: 201 })
}

export async function DELETE(req: Request) {
  const url = new URL(req.url)
  const id  = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await adminClient
    .from('curated_parlays')
    .update({ active: false })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
