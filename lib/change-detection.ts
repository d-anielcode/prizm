/**
 * Change Detection for Two-Pass Parlay System
 * =============================================
 * Compares morning (Pass 1) parlay legs against midday re-enriched props
 * to determine if any material changes warrant regenerating the parlay.
 *
 * Material changes:
 *   - Player ruled OUT or DOUBTFUL (injury report)
 *   - Confidence score dropped below PLAY threshold (< 60)
 *   - Confidence dropped ≥ 10 points (even if still PLAY)
 *   - Line moved significantly (≥ 2 pts for PTS/REB/AST/PRA, ≥ 1 for 3PM/BLK/STL)
 *   - New LOCK emerged that was PLAY/LEAN in the morning (score jumped ≥ 8)
 */

export interface LegChange {
  playerName:          string
  statType:            string
  changeType:          'injury_out' | 'injury_doubtful' | 'score_dropped' | 'label_downgraded' | 'line_moved'
  detail:              string       // human-readable, e.g. "Confidence dropped from 78 LOCK to 52 LEAN"
  morningScore:        number
  middayScore:         number | null
  requiresReplacement: boolean
}

export interface ChangeReport {
  parlayId:              string
  parlayType:            string
  hasSignificantChange:  boolean
  changes:               LegChange[]
  summary:               string      // e.g. "Jalen Brunson ruled OUT, leg replaced"
}

interface MorningLeg {
  player_name:       string
  stat_type:         string
  line:              number
  direction:         string
  confidence_label?: string
  confidence_score?: number
}

interface MiddayProp {
  player_name:       string
  stat_type:         string
  line:              number
  direction:         string
  confidence_label:  string | null
  confidence_score:  number | null
}

interface InjuryStatus {
  player_name:  string
  status:       'out' | 'doubtful' | 'questionable' | 'active'
}

// Line movement thresholds by stat type
const LINE_MOVE_THRESHOLD: Record<string, number> = {
  points:         2.0,
  rebounds:       2.0,
  assists:        2.0,
  pra:            3.0,
  three_pointers: 1.0,
  blocks:         1.0,
  steals:         1.0,
}

const SCORE_DROP_THRESHOLD = 10    // flag if score dropped by this much
const PLAY_FLOOR           = 60    // below this = not worthy of a parlay leg

export function detectChanges(
  parlayId:     string,
  parlayType:   string,
  morningLegs:  MorningLeg[],
  middayProps:  Map<string, MiddayProp>,   // keyed by "player_name|stat_type"
  injuries:     Map<string, InjuryStatus>, // keyed by player_name
): ChangeReport {
  const changes: LegChange[] = []

  for (const leg of morningLegs) {
    const key      = `${leg.player_name}|${leg.stat_type}`
    const midday   = middayProps.get(key)
    const injury   = injuries.get(leg.player_name)
    const mornScore = leg.confidence_score ?? 0

    // 1. Injury check — highest priority
    if (injury && (injury.status === 'out' || injury.status === 'doubtful')) {
      changes.push({
        playerName:          leg.player_name,
        statType:            leg.stat_type,
        changeType:          injury.status === 'out' ? 'injury_out' : 'injury_doubtful',
        detail:              `${leg.player_name} ruled ${injury.status.toUpperCase()}`,
        morningScore:        mornScore,
        middayScore:         midday?.confidence_score ?? null,
        requiresReplacement: true,
      })
      continue // no need to check other factors
    }

    // 2. No midday data (prop disappeared — player may have been pulled)
    if (!midday) {
      changes.push({
        playerName:          leg.player_name,
        statType:            leg.stat_type,
        changeType:          'score_dropped',
        detail:              `${leg.player_name} prop no longer available at midday`,
        morningScore:        mornScore,
        middayScore:         null,
        requiresReplacement: true,
      })
      continue
    }

    const midScore = midday.confidence_score ?? 0

    // 3. Score dropped below PLAY floor
    if (midScore < PLAY_FLOOR && mornScore >= PLAY_FLOOR) {
      changes.push({
        playerName:          leg.player_name,
        statType:            leg.stat_type,
        changeType:          'label_downgraded',
        detail:              `${leg.player_name} dropped from ${leg.confidence_label ?? '?'} (${mornScore}) to ${midday.confidence_label ?? '?'} (${midScore})`,
        morningScore:        mornScore,
        middayScore:         midScore,
        requiresReplacement: true,
      })
      continue
    }

    // 4. Large score drop (even if still PLAY)
    if (mornScore - midScore >= SCORE_DROP_THRESHOLD) {
      changes.push({
        playerName:          leg.player_name,
        statType:            leg.stat_type,
        changeType:          'score_dropped',
        detail:              `${leg.player_name} confidence dropped ${mornScore - midScore} pts (${mornScore} → ${midScore})`,
        morningScore:        mornScore,
        middayScore:         midScore,
        requiresReplacement: true,
      })
      continue
    }

    // 5. Significant line movement
    const threshold = LINE_MOVE_THRESHOLD[leg.stat_type] ?? 2.0
    const lineDelta = Math.abs(midday.line - leg.line)
    if (lineDelta >= threshold) {
      changes.push({
        playerName:          leg.player_name,
        statType:            leg.stat_type,
        changeType:          'line_moved',
        detail:              `${leg.player_name} line moved ${leg.line} → ${midday.line} (${lineDelta >= threshold ? 'significant' : 'minor'})`,
        morningScore:        mornScore,
        middayScore:         midScore,
        requiresReplacement: midScore < PLAY_FLOOR, // only replace if score also dropped
      })
    }
  }

  const significantChanges = changes.filter((c) => c.requiresReplacement)
  const hasSignificantChange = significantChanges.length > 0

  // Build human-readable summary
  let summary = ''
  if (significantChanges.length > 0) {
    const parts = significantChanges.map((c) => {
      if (c.changeType === 'injury_out')       return `${c.playerName} ruled OUT`
      if (c.changeType === 'injury_doubtful')  return `${c.playerName} ruled DOUBTFUL`
      if (c.changeType === 'label_downgraded') return `${c.playerName} confidence dropped`
      if (c.changeType === 'score_dropped')    return `${c.playerName} confidence dropped`
      if (c.changeType === 'line_moved')       return `${c.playerName} line moved significantly`
      return `${c.playerName} changed`
    })
    const legsReplaced = significantChanges.length === morningLegs.length
      ? 'fully rebuilt'
      : `${significantChanges.length} leg${significantChanges.length > 1 ? 's' : ''} replaced`
    summary = `${parts.join(', ')} — ${legsReplaced}`
  }

  return { parlayId, parlayType, hasSignificantChange, changes, summary }
}
