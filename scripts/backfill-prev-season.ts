// scripts/backfill-prev-season.ts
//
// Backfills player_game_logs for the full 2024-25 NBA season (regular season + playoffs).
// Fetches box scores directly from ESPN — no HTTP timeout limitation.
//
// Run:  npx tsx scripts/backfill-prev-season.ts
//
// The 2024-25 season:
//   Regular season: Oct 22, 2024 – Apr 13, 2025
//   Playoffs:       Apr 19, 2025 – Jun 22, 2025
//
// Why backfill prior season?
//   - Provides richer historical context for vsOpponent and homeAway factors
//   - Players' full 24-25 history improves hit rate calculations for early 25-26 games
//   - More training data for the weight optimizer
//
// Note: existing 25-26 rows are NOT overwritten (upsert on conflict does nothing
// for rows with the same player_name+game_date key that already exist with good data).

import { createClient } from '@supabase/supabase-js'
import { fetchGameLogsFromESPN, dateRange } from '../lib/espn-gamelogs'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const SEASON_START = '2024-10-22'
const SEASON_END   = '2025-06-22'  // covers through NBA Finals

const BATCH_SIZE    = 200   // rows per upsert
const DELAY_MS      = 200   // ms between dates (polite to ESPN)
const LOG_INTERVAL  = 10    // print progress every N dates

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const dates = dateRange(SEASON_START, SEASON_END)

  console.log(`\n2024-25 NBA Season Backfill`)
  console.log(`Dates: ${SEASON_START} → ${SEASON_END} (${dates.length} calendar days)`)
  console.log('────────────────────────────────────────────────────────────')

  let totalGames    = 0
  let totalUpserted = 0
  let totalSkipped  = 0
  let totalErrors   = 0
  const t0 = Date.now()

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]

    // Progress log
    if (i > 0 && i % LOG_INTERVAL === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
      const pct     = ((i / dates.length) * 100).toFixed(0)
      console.log(`  [${pct}%] ${i}/${dates.length} dates  |  ${totalGames} games  |  ${totalUpserted} rows  (${elapsed}s elapsed)`)
    }

    try {
      const { rows, games, total } = await fetchGameLogsFromESPN(date)

      if (rows.length === 0) {
        if (total === 0) {
          // No games scheduled — skip silently (off-days, all-star break, etc.)
          totalSkipped++
        }
        await sleep(DELAY_MS)
        continue
      }

      totalGames += games

      // Upsert in batches
      let upserted = 0
      for (let j = 0; j < rows.length; j += BATCH_SIZE) {
        const slice = rows.slice(j, j + BATCH_SIZE)
        const { error } = await supabase
          .from('player_game_logs')
          .upsert(slice, { onConflict: 'player_name,game_date' })
        if (!error) {
          upserted += slice.length
        } else {
          console.error(`  [ERROR] upsert on ${date}:`, error.message)
          totalErrors++
        }
      }

      totalUpserted += upserted

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  [ERROR] ${date}: ${msg}`)
      totalErrors++
    }

    await sleep(DELAY_MS)
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  console.log('\n════════════════════════════════════════════════════════════')
  console.log('BACKFILL COMPLETE')
  console.log(`  Dates processed:  ${dates.length} (${totalSkipped} off-days skipped)`)
  console.log(`  Games found:      ${totalGames}`)
  console.log(`  Rows upserted:    ${totalUpserted}`)
  console.log(`  Errors:           ${totalErrors}`)
  console.log(`  Time elapsed:     ${elapsed}s`)
  console.log('════════════════════════════════════════════════════════════\n')
  console.log('Next step: re-run the weight optimizer to use expanded game log history.')
  console.log('  npx tsx scripts/optimize-weights.ts')
}

main().catch(console.error)
