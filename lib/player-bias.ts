/**
 * lib/player-bias.ts — Read-time helpers for the player_line_bias table.
 *
 * The table is populated weekly by /api/player-bias?action=analyze. Each row
 * records, for a (player, stat_type) pair, how often the *over* hits historically
 * along with sample size. The confidence engine already consumes this for its
 * biasAdj additive (see lib/confidence.ts:903–909). These helpers are for the
 * UI layer — surfacing the signal to users so they can see why a prop scored
 * the way it did.
 */
import { supabase } from '@/lib/supabase'
import type { Direction, StatType } from '@/types'

export interface PlayerBiasRow {
  player_name:  string
  stat_type:    string
  hit_rate:     number
  sample_count: number
  median_ratio: number | null
}

/** Minimum sample size before we display the bias to users. Mirrors the
 *  scoring threshold so the UI never claims an edge the score didn't apply. */
export const BIAS_MIN_SAMPLES = 6

/** Hit-rate distance from 50% required to consider the bias "meaningful" for
 *  display. 5pp is the floor — below that, sample noise dominates. */
export const BIAS_DISPLAY_THRESHOLD = 0.05

/** Load all player_line_bias rows keyed by "player|stat_type". Server-only. */
export async function loadPlayerBiasMap(): Promise<Map<string, PlayerBiasRow>> {
  const map = new Map<string, PlayerBiasRow>()
  const { data, error } = await supabase
    .from('player_line_bias')
    .select('player_name, stat_type, hit_rate, sample_count, median_ratio')
  if (error || !data) return map
  for (const row of data as PlayerBiasRow[]) {
    map.set(`${row.player_name}|${row.stat_type}`, row)
  }
  return map
}

export interface BiasSignal {
  /** Direction of the mispricing: 'under' = book over-prices the over (so taking
   *  under is the edge); 'over' = book under-prices the over (taking over is the edge). */
  edge:        'over' | 'under'
  /** Hit-rate distance from 50% — magnitude of the bias, 0..0.5. */
  magnitude:   number
  /** Underlying sample size — confidence in the bias. */
  sampleCount: number
  /** Whether this bias agrees with the user's pick direction (used to color the chip). */
  alignsWithPick: boolean
}

/**
 * Convert a raw bias row into a display signal for a specific prop direction.
 * Returns null when:
 *   - no bias row exists for this player|stat
 *   - sample_count below the minimum
 *   - magnitude below the display threshold
 *
 * `pickDirection` is the user's bet direction so the chip can show whether the
 * historical bias agrees with the pick.
 */
export function biasSignalFor(
  bias:          PlayerBiasRow | undefined,
  pickDirection: Direction,
): BiasSignal | null {
  if (!bias) return null
  if (bias.sample_count < BIAS_MIN_SAMPLES) return null
  const delta = bias.hit_rate - 0.5
  if (Math.abs(delta) < BIAS_DISPLAY_THRESHOLD) return null
  const edge: 'over' | 'under' = delta > 0 ? 'over' : 'under'
  return {
    edge,
    magnitude:      Math.abs(delta),
    sampleCount:    bias.sample_count,
    alignsWithPick: edge === pickDirection,
  }
}

/** Convenience lookup using a (player, stat) pair. */
export function lookupBias(
  map:        Map<string, PlayerBiasRow>,
  playerName: string,
  statType:   StatType,
): PlayerBiasRow | undefined {
  return map.get(`${playerName}|${statType}`)
}
