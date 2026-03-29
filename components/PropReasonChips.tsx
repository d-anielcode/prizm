'use client'

import { useState } from 'react'

interface Props {
  reason?: string | null
}

interface Chip {
  label: string
  dataPoint: string   // the specific parsed sentence shown in the panel
  explanation: string // plain-English explanation of what this signal means
  color: string
  borderColor: string // hover/active ring color
}

// ── Explanations ─────────────────────────────────────────────────────────────

const EXPLANATIONS: Record<string, string> = {
  hitRate:
    'How often this player has cleared this exact line recently. A rate above 65% is a strong bullish signal — the market may be underpricing their output. Below 50% suggests the books have set this line accurately or even generously. More games sampled = more reliable signal.',
  h2h:
    'Head-to-head history against tonight\'s specific opponent. Some players consistently perform better or worse against certain defensive schemes, individual matchups, or coaching styles. Small samples (under 4 games) carry less weight.',
  seasonAvg:
    'The player\'s full-season average compared to tonight\'s line. When the average sits well above the line, books may be setting a low number to attract balanced action — a potential edge. When it sits below, the prop is likely priced at or above fair value.',
  matchup:
    'How well tonight\'s opponent defends this specific stat across the league this season. A bottom-10 defense (high rank number) gives up significantly more of this stat on average — a meaningful edge for OVER props. A top-10 defense (low rank number) is a red flag.',
  trend:
    'Whether the player is running hot or cold over the last 5 games relative to their season average. A 12%+ deviation in either direction often signals a real shift — role change, injury recovery, matchup run, or usage fluctuation — not just randomness.',
  consistency:
    'How stable this player\'s output is game to game. A consistent performer has low variance — their average is a reliable predictor. A volatile stat swings heavily, meaning even a well-priced line can miss badly on any given night. Consistency increases betting confidence; volatility demands caution.',
  blowout:
    'A large point spread means one team is heavily favored. When games get out of hand, coaches bench starters early in the 4th quarter to protect their stars — cutting directly into counting stats like points, assists, and rebounds. The bigger the spread, the higher this risk.',
  pace:
    'The game\'s over/under total is a proxy for expected pace and possessions. More possessions = more opportunities to accumulate counting stats. A high total (230+) meaningfully boosts the floor for points, assists, and PRA props. Low totals are a mild headwind.',
  lineMove:
    'How the line has moved since it opened. When the line shifts in the same direction as your pick (e.g. an OVER line that rises), the market — often driven by sharp money — is agreeing with you. A line moving against your pick is a warning sign that the smart money disagrees.',
  sharpMoney:
    'The implied probability of the bet has shifted significantly since morning lines opened. Sharp bettors are high-volume, sophisticated players whose action forces sportsbooks to adjust odds to limit exposure. A large shift toward your pick means the sharps are on your side — one of the strongest signals available. A shift away is a red flag regardless of other factors.',
}

// ── Parser ────────────────────────────────────────────────────────────────────

function getSentences(reason: string): string[] {
  return reason.split(/\. (?=[A-Z])/).map((s) => (s.endsWith('.') ? s : s + '.'))
}

function findSentence(sentences: string[], pattern: RegExp): string {
  return sentences.find((s) => pattern.test(s)) ?? ''
}

function parseReason(reason: string): Chip[] {
  const chips: Chip[] = []
  const sentences = getSentences(reason)

  // 1. Recent hit rate
  const hitMatch = reason.match(/has gone \w+ [\d.]+ \w+ in (\d+) of their last (\d+) games/)
  if (hitMatch) {
    const hits = parseInt(hitMatch[1])
    const total = parseInt(hitMatch[2])
    const rate = hits / total
    const color =
      rate >= 0.65
        ? 'bg-emerald-500/15 text-emerald-400'
        : rate >= 0.5
          ? 'bg-amber-500/15 text-amber-400'
          : 'bg-red-500/15 text-red-400'
    chips.push({
      label: `${hits}/${total} Last ${total} Games`,
      dataPoint: findSentence(sentences, /has gone .+ in \d+ of their last \d+ games/),
      explanation: EXPLANATIONS.hitRate,
      color,
      borderColor: rate >= 0.65 ? 'ring-emerald-500/50' : rate >= 0.5 ? 'ring-amber-500/50' : 'ring-red-500/50',
    })
  }

  // 2. Head-to-head
  const h2hMatch = reason.match(/In (\d+) previous matchups against (.+?), they've hit the \w+ (\d+)\/\d+/)
  if (h2hMatch) {
    const total = parseInt(h2hMatch[1])
    const opp = h2hMatch[2]
    const hits = parseInt(h2hMatch[3])
    const rate = hits / total
    const color =
      rate >= 0.6
        ? 'bg-emerald-500/15 text-emerald-400'
        : rate >= 0.4
          ? 'bg-white/5 text-white/40'
          : 'bg-red-500/15 text-red-400'
    chips.push({
      label: `${hits}/${total} H2H vs ${opp}`,
      dataPoint: findSentence(sentences, /previous matchups against/),
      explanation: EXPLANATIONS.h2h,
      color,
      borderColor: rate >= 0.6 ? 'ring-emerald-500/50' : rate >= 0.4 ? 'ring-white/20' : 'ring-red-500/50',
    })
  }

  // 3. Season average vs line
  const avgMatch = reason.match(/Season average of ([\d.]+)[^—]*—\s*([\d.]+)%\s*(above|below)/)
  if (avgMatch) {
    const avg = avgMatch[1]
    const pct = avgMatch[2]
    const dir = avgMatch[3]
    chips.push({
      label: `Avg ${avg} · ${dir === 'above' ? '+' : '-'}${pct}% vs Line`,
      dataPoint: findSentence(sentences, /Season average of/),
      explanation: EXPLANATIONS.seasonAvg,
      color: dir === 'above' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400',
      borderColor: dir === 'above' ? 'ring-blue-500/50' : 'ring-orange-500/50',
    })
  }

  // 4. Matchup quality
  const matchupMatch = reason.match(/(Tough|Favorable) matchup[^#]*#(\d+)/)
  if (matchupMatch) {
    const favorable = matchupMatch[1] === 'Favorable'
    const rank = matchupMatch[2]
    chips.push({
      label: favorable ? `Favorable Matchup (Def. #${rank})` : `Tough Matchup (Def. #${rank})`,
      dataPoint: findSentence(sentences, /matchup —/),
      explanation: EXPLANATIONS.matchup,
      color: favorable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
      borderColor: favorable ? 'ring-emerald-500/50' : 'ring-red-500/50',
    })
  }

  // 5. Trend
  const trendMatch = reason.match(/Trending (up|down) recently — ([\d.]+)[^v]+vs a season average of ([\d.]+)/)
  if (trendMatch) {
    const up = trendMatch[1] === 'up'
    const l5 = trendMatch[2]
    const season = trendMatch[3]
    chips.push({
      label: up ? `↑ Gaining Form (${l5} L5 vs ${season} Avg)` : `↓ Cooling Off (${l5} L5 vs ${season} Avg)`,
      dataPoint: findSentence(sentences, /Trending (up|down) recently/),
      explanation: EXPLANATIONS.trend,
      color: up ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
      borderColor: up ? 'ring-emerald-500/50' : 'ring-red-500/50',
    })
  }

  // 6. Consistency / variance
  if (/Rock-solid consistency/.test(reason)) {
    chips.push({
      label: 'Consistent Performer',
      dataPoint: findSentence(sentences, /Rock-solid consistency/),
      explanation: EXPLANATIONS.consistency,
      color: 'bg-emerald-500/10 text-emerald-500',
      borderColor: 'ring-emerald-500/40',
    })
  } else if (/High-variance stat/.test(reason)) {
    chips.push({
      label: 'Volatile Stat',
      dataPoint: findSentence(sentences, /High-variance stat/),
      explanation: EXPLANATIONS.consistency,
      color: 'bg-amber-500/15 text-amber-400',
      borderColor: 'ring-amber-500/50',
    })
  }

  // 7. Blowout risk
  const blowoutMatch = reason.match(/(High|Moderate) blowout risk — ([\d.]+)-point spread/)
  if (blowoutMatch) {
    chips.push({
      label: `${blowoutMatch[1]} Blowout Risk (−${blowoutMatch[2]} Spread)`,
      dataPoint: findSentence(sentences, /blowout risk/),
      explanation: EXPLANATIONS.blowout,
      color: 'bg-amber-500/15 text-amber-400',
      borderColor: 'ring-amber-500/50',
    })
  }

  // 8. Pace
  const paceMatch = reason.match(/(High|Slow)-paced game expected \(O\/U ([\d.]+)\)/)
  if (paceMatch) {
    const fast = paceMatch[1] === 'High'
    chips.push({
      label: fast ? `Fast-Paced Game (O/U ${paceMatch[2]})` : `Slow-Paced Game (O/U ${paceMatch[2]})`,
      dataPoint: findSentence(sentences, /paced game expected/),
      explanation: EXPLANATIONS.pace,
      color: 'bg-white/5 text-white/40',
      borderColor: 'ring-white/20',
    })
  }

  // 9. Line movement
  const lineMovMatch = reason.match(/Line moved (up|down) ([\d.]+) pts.*?(confirming|going against)/)
  if (lineMovMatch) {
    const up = lineMovMatch[1] === 'up'
    const pts = lineMovMatch[2]
    const confirming = lineMovMatch[3] === 'confirming'
    chips.push({
      label: `Line ${up ? 'Rose' : 'Fell'} ${pts}pt${parseFloat(pts) !== 1 ? 's' : ''} — ${confirming ? 'Books Agree' : 'Books Pushing Other Side'}`,
      dataPoint: findSentence(sentences, /Line moved/),
      explanation: EXPLANATIONS.lineMove,
      color: confirming ? 'bg-violet-500/15 text-violet-400' : 'bg-white/5 text-white/35',
      borderColor: confirming ? 'ring-violet-500/50' : 'ring-white/20',
    })
  }

  // 10. Sharp odds movement
  const oddsMatch = reason.match(/Odds juice shifted[^+]*\+?([\d.]+)pp (toward|away from)/)
  if (oddsMatch) {
    const confirming = oddsMatch[2] === 'toward'
    const pct = oddsMatch[1]
    chips.push({
      label: confirming ? `Sharp Money Backing This (+${pct}pp)` : `Sharp Money on Other Side (${pct}pp)`,
      dataPoint: findSentence(sentences, /Odds juice shifted/),
      explanation: EXPLANATIONS.sharpMoney,
      color: confirming ? 'bg-violet-500/15 text-violet-400' : 'bg-white/5 text-white/35',
      borderColor: confirming ? 'ring-violet-500/50' : 'ring-white/20',
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
          {active.dataPoint && (
            <p className="text-[11px] text-white/60 mb-1.5 italic">{active.dataPoint}</p>
          )}
          <p className="text-[11px] text-white/50 leading-relaxed">{active.explanation}</p>
        </div>
      )}
    </div>
  )
}
