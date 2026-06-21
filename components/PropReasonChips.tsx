'use client'

import { useState } from 'react'

interface Props {
  reason?: string | null
}

interface Chip {
  label: string
  explanation: string
  color: string
}

// ── Explanations ─────────────────────────────────────────────────────────────

const EXPLANATIONS: Record<string, string> = {
  hitRate:
    'How often this player has hit this line in recent games. Above 65% suggests the line may be set too low. Below 50% means the book has it priced accurately or in their favor.',
  h2h:
    'This player\'s track record against tonight\'s specific opponent. Some players consistently over- or under-perform against certain teams due to matchup style or individual defenders.',
  seasonAvg:
    'The player\'s season average relative to tonight\'s line. A large gap above the line is a potential edge — books sometimes shade lines low to attract action on both sides.',
  lineValue:
    'How the prop line compares to recent performance. A generous line sits well below the player\'s average, giving a built-in edge. A tight line means the book has priced it aggressively.',
  matchup:
    'How well tonight\'s opponent defends this stat league-wide. A weak defense (high rank) gives up more of this stat on average, which favors OVER props. A strong defense (low rank) is a headwind.',
  trend:
    'Whether the player is trending up or down over their last 5 games vs their season average. A sustained shift often reflects a real change — usage, role, health, or matchup run — not just variance.',
  homeAway:
    'Players often perform differently at home vs on the road. Home players benefit from familiar surroundings and crowd energy. Road splits can reveal players who struggle away from home.',
  consistency:
    'How much this stat varies game to game. A consistent performer\'s average is a reliable predictor. A volatile stat can swing wildly even when the average looks good — factor in extra uncertainty.',
  blowout:
    'A large spread means one team is heavily favored. Coaches rest starters early when games get out of hand, which cuts into counting stats like points, assists, and rebounds.',
  pace:
    'The game total reflects expected pace. More possessions mean more opportunities to accumulate stats. High totals favor counting stat OVERs; low totals are a mild headwind.',
  minutes:
    'How many minutes this player averages and their role tier. Star players with high minutes have more stable, predictable stat lines. Rotation players with fewer minutes carry more variance.',
  minutesStability:
    'How consistent this player\'s minutes are game to game. Large swings in playing time make stat predictions less reliable, even if averages look solid.',
  lineMove:
    'How much the line has moved since opening. A line moving in the same direction as your pick means the market agrees. A line moving against your pick is a warning sign.',
  sharpMoney:
    'The odds have shifted toward this pick since morning lines opened. Sportsbooks adjust when large, sophisticated bettors place heavy action on one side. A big shift in your direction means the sharp money agrees.',
  injury:
    'This player\'s current injury/availability status as reported by the team. OUT and DOUBTFUL players are unlikely to play. QUESTIONABLE players should be monitored up to tip-off.',
  teammateInjury:
    'When key teammates are out, remaining players often see increased usage, minutes, and opportunities — especially for points, assists, and rebounds.',
  staleData:
    'This player hasn\'t played recently. The model discounts historical stats when data is old, since form, fitness, and role may have changed during the absence.',
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parseReason(reason: string): Chip[] {
  const chips: Chip[] = []

  // 0a. Data staleness warning
  if (/Data may be stale/.test(reason)) {
    const daysMatch = reason.match(/last game was (\d+) days ago/)
    chips.push({
      label: `⚠️ Stale Data (${daysMatch ? daysMatch[1] + 'd' : '?'} ago)`,
      explanation: EXPLANATIONS.staleData,
      color: 'bg-amber-500/20 text-amber-300',
    })
  }

  // 0b. Player injury status
  const injuryMatch = reason.match(/listed as (OUT|DOUBTFUL|QUESTIONABLE)/)
  if (injuryMatch) {
    const status = injuryMatch[1]
    const color = status === 'OUT' ? 'bg-red-500/20 text-red-300' : status === 'DOUBTFUL' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-400'
    chips.push({ label: `⚠️ ${status}`, explanation: EXPLANATIONS.injury, color })
  }

  // 0c. Injured teammates boost
  if (/Teammate upgrade opportunity/.test(reason)) {
    const namesMatch = reason.match(/Teammate upgrade opportunity: (.+?) (?:is|are) OUT/)
    chips.push({
      label: `📈 Teammate${namesMatch?.[1]?.includes(',') ? 's' : ''} OUT → Usage Boost`,
      explanation: EXPLANATIONS.teammateInjury,
      color: 'bg-emerald-500/15 text-emerald-400',
    })
  } else if (/Teammate .+ is (?:questionable|doubtful)/.test(reason)) {
    chips.push({
      label: 'Teammate Questionable',
      explanation: EXPLANATIONS.teammateInjury,
      color: 'bg-amber-500/10 text-amber-400',
    })
  }

  // 1. Line value (generous/tight market pricing)
  if (/Line value:/.test(reason)) {
    const lvMatch = reason.match(/line of ([\d.]+) sits ([\d.]+) (?:below|above) their L10 average of ([\d.]+)/)
    chips.push({
      label: lvMatch ? `Generous Line (L10 Avg ${lvMatch[3]})` : 'Generous Line',
      explanation: EXPLANATIONS.lineValue,
      color: 'bg-emerald-500/15 text-emerald-400',
    })
  } else if (/Tight line:/.test(reason)) {
    const tlMatch = reason.match(/line of ([\d.]+) sits ([\d.]+) (?:above|below) their L10 average of ([\d.]+)/)
    chips.push({
      label: tlMatch ? `Tight Line (L10 Avg ${tlMatch[3]})` : 'Tight Line',
      explanation: EXPLANATIONS.lineValue,
      color: 'bg-red-500/15 text-red-400',
    })
  }

  // 2. Recent hit rate
  const hitMatch = reason.match(/has gone \w+ [\d.]+ \w+ in (\d+) of their last (\d+) games/)
  if (hitMatch) {
    const hits = parseInt(hitMatch[1])
    const total = parseInt(hitMatch[2])
    const rate = hits / total
    chips.push({
      label: `${hits}/${total} Last ${total} Games`,
      explanation: EXPLANATIONS.hitRate,
      color: rate >= 0.65 ? 'bg-emerald-500/15 text-emerald-400' : rate >= 0.5 ? 'bg-amber-500/15 text-amber-400' : 'bg-red-500/15 text-red-400',
    })
  }

  // 3. Head-to-head
  const h2hMatch = reason.match(/In (\d+) previous matchups against (.+?), they've hit the \w+ (\d+)\/\d+/)
  if (h2hMatch) {
    const total = parseInt(h2hMatch[1])
    const opp = h2hMatch[2]
    const hits = parseInt(h2hMatch[3])
    const rate = hits / total
    chips.push({
      label: `${hits}/${total} H2H vs ${opp}`,
      explanation: EXPLANATIONS.h2h,
      color: rate >= 0.6 ? 'bg-emerald-500/15 text-emerald-400' : rate >= 0.4 ? 'bg-white/5 text-white/40' : 'bg-red-500/15 text-red-400',
    })
  }

  // 4. Season average vs line
  const avgMatch = reason.match(/Season average of ([\d.]+)[^—]*—\s*([\d.]+)%\s*(above|below)/)
  if (avgMatch) {
    const dir = avgMatch[3]
    chips.push({
      label: `Avg ${avgMatch[1]} · ${dir === 'above' ? '+' : '-'}${avgMatch[2]}% vs Line`,
      explanation: EXPLANATIONS.seasonAvg,
      color: dir === 'above' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400',
    })
  }

  // 5. Home/Away splits
  const homeAwayMatch = reason.match(/Averaging ([\d.]+) \w+ (at home|on the road) this season \((\d+) games\)/)
  if (homeAwayMatch) {
    const avg = homeAwayMatch[1]
    const venue = homeAwayMatch[2] === 'at home' ? 'Home' : 'Away'
    chips.push({
      label: `${venue} Avg ${avg} (${homeAwayMatch[3]}G)`,
      explanation: EXPLANATIONS.homeAway,
      color: 'bg-sky-500/10 text-sky-400',
    })
  }

  // 6. Minutes + player tier
  const minMatch = reason.match(/Playing (\d+) minutes per game/)
  if (minMatch) {
    const mins = parseInt(minMatch[1])
    const isStar = /Star-player usage/.test(reason)
    const isRotation = /Rotation player/.test(reason)
    const tierLabel = isStar ? '★ Star' : isRotation ? 'Rotation' : 'Starter'
    chips.push({
      label: `${tierLabel} · ${mins} MPG`,
      explanation: EXPLANATIONS.minutes,
      color: isStar ? 'bg-violet-500/10 text-violet-400' : isRotation ? 'bg-white/5 text-white/40' : 'bg-white/5 text-white/50',
    })
  }

  // 7. Matchup quality
  const matchupMatch = reason.match(/(Tough|Favorable) matchup[^#]*#(\d+)/)
  if (matchupMatch) {
    const favorable = matchupMatch[1] === 'Favorable'
    chips.push({
      label: favorable ? `Favorable Matchup (Def. #${matchupMatch[2]})` : `Tough Matchup (Def. #${matchupMatch[2]})`,
      explanation: EXPLANATIONS.matchup,
      color: favorable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
    })
  }

  // 8. Trend
  const trendMatch = reason.match(/Trending (up|down) recently — ([\d.]+)[^v]+vs a season average of ([\d.]+)/)
  if (trendMatch) {
    const up = trendMatch[1] === 'up'
    chips.push({
      label: up ? `↑ Gaining Form (${trendMatch[2]} L5 vs ${trendMatch[3]} Avg)` : `↓ Cooling Off (${trendMatch[2]} L5 vs ${trendMatch[3]} Avg)`,
      explanation: EXPLANATIONS.trend,
      color: up ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
    })
  }

  // 9. Pace
  const paceMatch = reason.match(/(High|Slow)-paced game expected \(O\/U ([\d.]+)\)/)
  if (paceMatch) {
    chips.push({
      label: paceMatch[1] === 'High' ? `Fast-Paced Game (O/U ${paceMatch[2]})` : `Slow-Paced Game (O/U ${paceMatch[2]})`,
      explanation: EXPLANATIONS.pace,
      color: 'bg-white/5 text-white/40',
    })
  }

  // 10. Blowout risk
  const blowoutMatch = reason.match(/(High|Moderate) blowout risk — ([\d.]+)-point spread/)
  if (blowoutMatch) {
    chips.push({
      label: `${blowoutMatch[1]} Blowout Risk (${blowoutMatch[2]}pt Spread)`,
      explanation: EXPLANATIONS.blowout,
      color: 'bg-amber-500/15 text-amber-400',
    })
  }

  // 11. Consistency / variance
  if (/Rock-solid consistency/.test(reason)) {
    chips.push({ label: 'Consistent Performer', explanation: EXPLANATIONS.consistency, color: 'bg-emerald-500/10 text-emerald-500' })
  } else if (/High-variance stat/.test(reason)) {
    chips.push({ label: 'Volatile Stat', explanation: EXPLANATIONS.consistency, color: 'bg-amber-500/15 text-amber-400' })
  }

  // 12. Minutes stability
  const minStabMatch = reason.match(/Minutes vary significantly \(σ≈(\d+) min\/game\)/)
  if (minStabMatch) {
    chips.push({
      label: `⚠️ Unstable Minutes (σ ${minStabMatch[1]}m)`,
      explanation: EXPLANATIONS.minutesStability,
      color: 'bg-amber-500/15 text-amber-400',
    })
  }

  // 13. Line movement
  const lineMovMatch = reason.match(/Line moved (up|down) ([\d.]+) pts.*?(confirming|going against)/)
  if (lineMovMatch) {
    const up = lineMovMatch[1] === 'up'
    const confirming = lineMovMatch[3] === 'confirming'
    chips.push({
      label: `Line ${up ? 'Rose' : 'Fell'} ${lineMovMatch[2]}pt${parseFloat(lineMovMatch[2]) !== 1 ? 's' : ''} — ${confirming ? 'Books Agree' : 'Pushing Other Side'}`,
      explanation: EXPLANATIONS.lineMove,
      color: confirming ? 'bg-violet-500/15 text-violet-400' : 'bg-white/5 text-white/35',
    })
  }

  // 14. Sharp odds movement
  const oddsMatch = reason.match(/Odds juice shifted[^+]*\+?([\d.]+)pp (toward|away from)/)
  if (oddsMatch) {
    const confirming = oddsMatch[2] === 'toward'
    chips.push({
      label: confirming ? `Sharp Money Backing This (+${oddsMatch[1]}pp)` : `Sharp Money on Other Side (${oddsMatch[1]}pp)`,
      explanation: EXPLANATIONS.sharpMoney,
      color: confirming ? 'bg-violet-500/15 text-violet-400' : 'bg-white/5 text-white/35',
    })
  }

  return chips
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PropReasonChips({ reason }: Props) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  if (!reason) return null
  const chips = parseReason(reason)
  if (chips.length === 0) return null

  const active = activeIdx !== null ? chips[activeIdx] : null

  function toggle(i: number) {
    setActiveIdx((prev) => (prev === i ? null : i))
  }

  return (
    <div className="flex flex-col gap-1.5 mt-1.5">
      {/* Chip row */}
      <div className="flex items-center flex-wrap gap-1">
        {chips.map((chip, i) => (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); toggle(i) }}
            className={[
              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight transition-all duration-150',
              'ring-1 ring-transparent hover:ring-white/25',
              activeIdx === i ? 'ring-white/40' : '',
              chip.color,
            ].join(' ')}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Explanation panel */}
      {active && (
        <div className="rounded-lg border border-white/10 bg-[#0f0f17] px-3 py-2.5 shadow-xl">
          <p className="text-[10px] font-semibold text-white/40 uppercase tracking-wider mb-1">{active.label}</p>
          <p className="text-[11px] text-white/55 leading-relaxed">{active.explanation}</p>
        </div>
      )}
    </div>
  )
}
