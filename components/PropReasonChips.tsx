'use client'

interface Props {
  reason?: string | null
}

interface Chip {
  label: string
  tooltip: string
  color: string
}

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
    chips.push({
      label: `${hits}/${total} Last ${total} Games`,
      tooltip: findSentence(sentences, /has gone .+ in \d+ of their last \d+ games/),
      color:
        rate >= 0.65
          ? 'bg-emerald-500/15 text-emerald-400'
          : rate >= 0.5
            ? 'bg-amber-500/15 text-amber-400'
            : 'bg-red-500/15 text-red-400',
    })
  }

  // 2. Head-to-head vs opponent
  const h2hMatch = reason.match(/In (\d+) previous matchups against (.+?), they've hit the \w+ (\d+)\/\d+/)
  if (h2hMatch) {
    const total = parseInt(h2hMatch[1])
    const opp = h2hMatch[2]
    const hits = parseInt(h2hMatch[3])
    const rate = hits / total
    chips.push({
      label: `${hits}/${total} H2H vs ${opp}`,
      tooltip: findSentence(sentences, /previous matchups against/),
      color:
        rate >= 0.6
          ? 'bg-emerald-500/15 text-emerald-400'
          : rate >= 0.4
            ? 'bg-white/5 text-white/40'
            : 'bg-red-500/15 text-red-400',
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
      tooltip: findSentence(sentences, /Season average of/),
      color: dir === 'above' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400',
    })
  }

  // 4. Matchup quality
  const matchupMatch = reason.match(/(Tough|Favorable) matchup[^#]*#(\d+)/)
  if (matchupMatch) {
    const favorable = matchupMatch[1] === 'Favorable'
    const rank = matchupMatch[2]
    chips.push({
      label: favorable ? `Favorable Matchup (Def. #${rank})` : `Tough Matchup (Def. #${rank})`,
      tooltip: findSentence(sentences, /matchup —/),
      color: favorable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
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
      tooltip: findSentence(sentences, /Trending (up|down) recently/),
      color: up ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400',
    })
  }

  // 6. Consistency / variance
  if (/Rock-solid consistency/.test(reason)) {
    chips.push({
      label: 'Consistent Performer',
      tooltip: findSentence(sentences, /Rock-solid consistency/),
      color: 'bg-emerald-500/10 text-emerald-500',
    })
  } else if (/High-variance stat/.test(reason)) {
    chips.push({
      label: 'Volatile Stat',
      tooltip: findSentence(sentences, /High-variance stat/),
      color: 'bg-amber-500/15 text-amber-400',
    })
  }

  // 7. Blowout risk
  const blowoutMatch = reason.match(/(High|Moderate) blowout risk — ([\d.]+)-point spread/)
  if (blowoutMatch) {
    chips.push({
      label: `${blowoutMatch[1]} Blowout Risk (−${blowoutMatch[2]} Spread)`,
      tooltip: findSentence(sentences, /blowout risk/),
      color: 'bg-amber-500/15 text-amber-400',
    })
  }

  // 8. Pace
  const paceMatch = reason.match(/(High|Slow)-paced game expected \(O\/U ([\d.]+)\)/)
  if (paceMatch) {
    const fast = paceMatch[1] === 'High'
    chips.push({
      label: fast ? `Fast-Paced Game (O/U ${paceMatch[2]})` : `Slow-Paced Game (O/U ${paceMatch[2]})`,
      tooltip: findSentence(sentences, /paced game expected/),
      color: 'bg-white/5 text-white/40',
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
      tooltip: findSentence(sentences, /Line moved/),
      color: confirming ? 'bg-violet-500/15 text-violet-400' : 'bg-white/5 text-white/35',
    })
  }

  // 10. Sharp odds movement
  const oddsMatch = reason.match(/Odds juice shifted[^+]*\+?([\d.]+)pp (toward|away from)/)
  if (oddsMatch) {
    const confirming = oddsMatch[2] === 'toward'
    const pct = oddsMatch[1]
    chips.push({
      label: confirming ? `Sharp Money Backing This (+${pct}pp)` : `Sharp Money on Other Side (${pct}pp)`,
      tooltip: findSentence(sentences, /Odds juice shifted/),
      color: confirming ? 'bg-violet-500/15 text-violet-400' : 'bg-white/5 text-white/35',
    })
  }

  return chips
}

function Chip({ chip }: { chip: Chip }) {
  return (
    <span className="relative group/chip inline-flex">
      <span
        className={`cursor-default inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${chip.color}`}
      >
        {chip.label}
      </span>
      {chip.tooltip && (
        <div className="pointer-events-none absolute bottom-full left-0 mb-2 z-50 hidden group-hover/chip:block">
          <div className="w-56 rounded-lg border border-white/10 bg-[#0f0f17] px-3 py-2 shadow-2xl shadow-black/60">
            <p className="text-[11px] text-white/65 leading-relaxed">{chip.tooltip}</p>
          </div>
        </div>
      )}
    </span>
  )
}

export function PropReasonChips({ reason }: Props) {
  if (!reason) return null
  const chips = parseReason(reason)
  if (chips.length === 0) return null

  return (
    <div className="flex items-center flex-wrap gap-1 mt-1.5">
      {chips.map((chip, i) => (
        <Chip key={i} chip={chip} />
      ))}
    </div>
  )
}
