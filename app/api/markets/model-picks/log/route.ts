// /api/markets/model-picks/log
//
// Logs today's Kalshi model picks for games tipping in the next 30 minutes into
// kalshi_model_picks (first price seen wins: UNIQUE(ticker, side), duplicates ignored).
// Called every 15 min by the kalshi_live pipeline phase; graded overnight by
// scripts/kalshi_model_grade.py.

import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { requireCronAuth } from '@/lib/api-auth'
import { logger } from '@/lib/logger'
import { loadTodayPicks } from '@/lib/kalshi/model-picks-data'
import { dueForLogging, toLogRow } from '@/lib/kalshi/model-picks'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: Request) {
  const authError = requireCronAuth(req)
  if (authError) return authError
  try {
    const now = new Date()
    const { gameDate, markets, picks } = await loadTodayPicks(supabase, now)
    const due = dueForLogging(picks, now)
    let logged = 0
    if (due.length) {
      const { data, error } = await supabase.from('kalshi_model_picks')
        .upsert(due.map(toLogRow), { onConflict: 'ticker,side', ignoreDuplicates: true })
        .select('id')
      if (error) throw new Error(`kalshi_model_picks insert: ${error.message}`)
      logged = data?.length ?? 0
    }
    return NextResponse.json({ game_date: gameDate, markets, picks: picks.length, candidates: due.length, logged })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[/api/markets/model-picks/log] failed', { error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
