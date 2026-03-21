'use client'
// v2
import { useState, useMemo, useCallback } from 'react'
import type { Prop } from '@/types'

const STAT_LABELS: Record<string, string> = {
  points:         'PTS',
  rebounds:       'REB',
  assists:        'AST',
  steals:         'STL',
  blocks:         'BLK',
  three_pointers: '3PM',
  pra:            'PRA',
}

type Preset = 'safe' | 'medium' | 'extreme'

const PRESETS: Record<Preset, { label: string; legs: number; targetMin: number; targetMax: number }> = {
  safe:    { label: 'Safe',    legs: 2, targetMin: 1.5, targetMax: 4  },
  medium:  { label: 'Medium',  legs: 3, targetMin: 4,   targetMax: 9  },
  extreme: { label: 'Extreme', legs: 5, targetMin: 9,   targetMax: 25 },
}

function americanToDecimal(american: number): number {
  if (american > 0) return american / 100 + 1
  return 100 / Math.abs(american) + 1
}

function calcMultiplier(legs: Prop[]): number {
  return legs.reduce((acc, p) => acc * americanToDecimal(p.odds ?? -110), 1)
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    const j = Math.abs(s) % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function propKey(p: Prop) {
  return `${p.player_name}|${p.stat_type}`
}

// ── Lock icon ────────────────────────────────────────────────────────────────
function LockIcon({ locked }: { locked: boolean }) {
  return locked ? (
    // Closed lock
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd"
        d="M12 1a5 5 0 00-5 5v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V10a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 7V6a3 3 0 10-6 0v2h6zm-3 4a1 1 0 011 1v3a1 1 0 11-2 0v-3a1 1 0 011-1z" />
    </svg>
  ) : (
    // Open lock
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="5" y="11" width="14" height="11" rx="2" />
      <path strokeLinecap="round" d="M8 11V7a4 4 0 017.75-1.4" />
    </svg>
  )
}

// ── Hover tooltip — shows only the expanded reasoning ────────────────────────
function ReasonTooltip({ reason }: { reason: string | undefined }) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-50 pointer-events-none">
      <div className="rounded-xl border border-white/[0.12] bg-[#0d1320]/95 backdrop-blur-sm px-4 py-3 shadow-2xl">
        <p className="text-xs text-white/60 leading-relaxed">
          {reason || 'No analysis available for this pick.'}
        </p>
        {/* Arrow */}
        <div className="absolute left-6 top-full w-0 h-0
          border-l-[6px] border-l-transparent
          border-r-[6px] border-r-transparent
          border-t-[6px] border-t-[#0d1320]" />
      </div>
    </div>
  )
}

interface Props {
  allProps: Prop[]
}

export default function ParlayBuilder({ allProps }: Props) {
  const [preset, setPreset]             = useState<Preset>('medium')
  const [enabledStats, setEnabledStats] = useState<Set<string>>(new Set(Object.keys(STAT_LABELS)))
  const [parlay, setParlay]             = useState<Prop[] | null>(null)
  const [seed, setSeed]                 = useState(1)
  const [tooFew, setTooFew]             = useState(false)
  const [lockedKeys, setLockedKeys]     = useState<Set<string>>(new Set())
  const [hoveredKey, setHoveredKey]     = useState<string | null>(null)

  const eligible = useMemo(() => {
    const seen = new Set<string>()
    return allProps
      .filter((p) => (p.confidence_label === 'LOCK' || p.confidence_label === 'PLAY') && enabledStats.has(p.stat_type))
      .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
      .filter((p) => {
        const key = propKey(p)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [allProps, enabledStats])

  const build = useCallback(() => {
    const config = PRESETS[preset]
    setTooFew(false)

    // Locked picks from the current parlay
    const locked = (parlay ?? []).filter((p) => lockedKeys.has(propKey(p)))
    const lockedPlayers = new Set(locked.map((p) => p.player_name))
    const slotsNeeded = config.legs - locked.length

    if (slotsNeeded <= 0) {
      // All slots are locked — just keep them
      setParlay(locked)
      setSeed((s) => s + 1)
      return
    }

    if (eligible.length === 0) {
      setParlay(locked.length > 0 ? locked : [])
      setTooFew(true)
      return
    }

    // Pool: eligible props excluding locked players
    const pool = seededShuffle(
      eligible.filter((p) => !lockedPlayers.has(p.player_name)).slice(0, 20),
      seed
    )

    const picked: Prop[] = []
    const usedPlayers = new Set(lockedPlayers)
    for (const p of pool) {
      if (picked.length >= slotsNeeded) break
      if (usedPlayers.has(p.player_name)) continue
      picked.push(p)
      usedPlayers.add(p.player_name)
    }

    if (picked.length < slotsNeeded) setTooFew(true)

    setParlay([...locked, ...picked])
    setSeed((s) => s + 1)
  }, [eligible, preset, seed, parlay, lockedKeys])

  const toggleLock = (p: Prop) => {
    const key = propKey(p)
    setLockedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleStat = (stat: string) => {
    setEnabledStats((prev) => {
      const next = new Set(prev)
      if (next.has(stat) && next.size > 1) next.delete(stat)
      else next.add(stat)
      return next
    })
    setParlay(null)
    setLockedKeys(new Set())
    setTooFew(false)
  }

  const multiplier = parlay && parlay.length > 0 ? calcMultiplier(parlay) : null

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-black text-white tracking-tight">Parlay Builder</h2>
        <span className="text-[11px] text-[#f0c060]/70 bg-[#e8a820]/8 border border-[#e8a820]/20 rounded-full px-2.5 py-0.5 font-semibold tracking-wide">
          AI · HIGH picks only
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* ── Controls ──────────────────────────────── */}
        <div className="lg:col-span-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />
          <div className="p-5 flex flex-col gap-5">

            {/* Risk presets */}
            <div>
              <p className="text-[11px] text-white/35 uppercase tracking-widest mb-2.5">Risk Level</p>
              <div className="flex flex-col gap-2">
                {(Object.entries(PRESETS) as [Preset, typeof PRESETS[Preset]][]).map(([key, cfg]) => {
                  const active = preset === key
                  const colors =
                    key === 'safe'    ? { active: 'bg-emerald-500/12 border-emerald-400/35 text-emerald-300', dot: 'bg-emerald-400' } :
                    key === 'medium'  ? { active: 'bg-[#e8a820]/10 border-[#e8a820]/35 text-[#f0c060]',      dot: 'bg-[#f0c060]'  } :
                                        { active: 'bg-red-500/12 border-red-400/35 text-red-300',             dot: 'bg-red-400'    }
                  return (
                    <button
                      key={key}
                      onClick={() => { setPreset(key); setParlay(null); setLockedKeys(new Set()); setTooFew(false) }}
                      className={`flex items-center justify-between rounded-xl px-4 py-3 border text-sm font-bold transition-all duration-200
                        ${active ? colors.active : 'bg-white/[0.02] border-white/[0.06] text-white/35 hover:text-white/55 hover:border-white/12'}`}
                    >
                      <div className="flex items-center gap-2.5">
                        {active && <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />}
                        {cfg.label}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-normal opacity-60">{cfg.legs} legs</span>
                        <span className={`text-xs font-bold ${active ? '' : 'opacity-40'}`}>
                          {key === 'safe' ? '1.5–4×' : key === 'medium' ? '4–9×' : '9–25×'}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Stat filters */}
            <div>
              <p className="text-[11px] text-white/35 uppercase tracking-widest mb-2.5">Include Stats</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(STAT_LABELS).map(([stat, label]) => (
                  <button
                    key={stat}
                    onClick={() => toggleStat(stat)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all duration-150 border
                      ${enabledStats.has(stat)
                        ? 'bg-[#e8a820]/10 border-[#e8a820]/30 text-[#f0c060]'
                        : 'bg-white/[0.03] border-white/[0.06] text-white/25 hover:text-white/45'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-white/20">{eligible.length} eligible HIGH picks today</p>

            <button
              onClick={build}
              disabled={eligible.length === 0 && lockedKeys.size === 0}
              className="w-full rounded-xl py-3.5 font-black text-sm transition-all duration-200
                bg-gradient-to-r from-[#e8a820] to-[#f5d060] text-black
                hover:shadow-[0_0_24px_rgba(232,168,32,0.35)]
                disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.98]"
            >
              {parlay
                ? lockedKeys.size > 0
                  ? `Regenerate · ${lockedKeys.size} locked`
                  : 'Regenerate'
                : 'Build My Parlay'}
            </button>
          </div>
        </div>

        {/* ── Result ──────────────────────────────────── */}
        <div className="lg:col-span-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden flex flex-col">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />

          {!parlay ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-10">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center">
                <svg className="w-7 h-7 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
                </svg>
              </div>
              <div className="text-center">
                <p className="text-white/30 text-sm">Pick your risk level and stats,</p>
                <p className="text-white/30 text-sm">then hit <span className="text-[#f0c060]/60">Build My Parlay</span></p>
              </div>
            </div>
          ) : parlay.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-10">
              <p className="text-white/30 text-sm text-center">
                Not enough HIGH picks for the selected stats.<br />
                Try enabling more stat types.
              </p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col p-5 gap-4">
              {/* Multiplier header */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] text-white/35 uppercase tracking-widest">Est. Multiplier</p>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="text-4xl font-black text-[#f0c060]">
                      {multiplier!.toFixed(1)}<span className="text-2xl">×</span>
                    </span>
                    {tooFew && (
                      <span className="text-[11px] text-yellow-400/70 bg-yellow-400/8 border border-yellow-400/20 rounded-full px-2 py-0.5">
                        fewer picks available
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-[11px] text-white/35 uppercase tracking-widest">Legs</p>
                  <p className="text-2xl font-black text-white/70 mt-0.5">{parlay.length}</p>
                </div>
              </div>

              <div className="h-px bg-white/[0.06]" />

              {/* Hint */}
              <p className="text-[11px] text-white/25">
                <span className="hidden sm:inline">Hover for full analysis · </span>Click a pick to lock it on regenerate
              </p>

              {/* Legs */}
              <div className="flex flex-col gap-2 flex-1">
                {parlay.map((prop, i) => {
                  const key = propKey(prop)
                  const isLocked = lockedKeys.has(key)
                  const isHovered = hoveredKey === `${key}-${i}`
                  const oddsStr = prop.odds != null
                    ? prop.odds > 0 ? `+${prop.odds}` : `${prop.odds}`
                    : '-110'
                  const labelColor =
                    prop.confidence_label === 'LOCK' ? 'text-violet-400 bg-violet-400/10 border-violet-400/20' :
                    prop.confidence_label === 'PLAY' ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' :
                    prop.confidence_label === 'LEAN' ? 'text-[#f0c060] bg-[#e8a820]/10 border-[#e8a820]/20' :
                                                       'text-red-400 bg-red-400/10 border-red-400/20'

                  return (
                    <div
                      key={prop.id ?? `${key}-${i}`}
                      className="relative"
                      onMouseEnter={() => setHoveredKey(`${key}-${i}`)}
                      onMouseLeave={() => setHoveredKey(null)}
                    >
                      {/* Tooltip — expanded reason only */}
                      {isHovered && <ReasonTooltip reason={prop.confidence_reason} />}

                      {/* Whole card is clickable to lock */}
                      <div
                        onClick={() => toggleLock(prop)}
                        title={isLocked ? 'Click to unlock' : 'Click to lock this pick'}
                        className={`flex items-center gap-3 rounded-xl px-4 py-3 border transition-all duration-150 cursor-pointer select-none
                          ${isLocked
                            ? 'bg-[#e8a820]/6 border-[#e8a820]/30 hover:bg-[#e8a820]/10'
                            : 'bg-white/[0.03] border-white/[0.06] hover:border-white/12 hover:bg-white/[0.05]'}`}
                      >
                        {/* Leg number */}
                        <span className="text-xs font-black text-white/15 w-5 shrink-0">{i + 1}</span>

                        {/* Player + pick */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-white truncate">{prop.player_name}</p>
                          <p className="text-xs text-white/40 mt-0.5">
                            <span className={`font-bold ${prop.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {prop.direction.toUpperCase()}
                            </span>
                            {' '}{prop.line} {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                          </p>
                          {prop.confidence_reason && (
                            <p className="text-[11px] text-white/25 mt-1 truncate sm:hidden">
                              {prop.confidence_reason}
                            </p>
                          )}
                        </div>

                        {/* Confidence badge + score — always visible */}
                        <div className="shrink-0 flex items-center gap-1.5">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${labelColor}`}>
                            {prop.confidence_label ?? '—'}
                          </span>
                          {prop.confidence_score != null && (
                            <span className="text-xs font-bold text-white/50">
                              {Math.round(prop.confidence_score)}
                            </span>
                          )}
                        </div>

                        {/* Odds */}
                        <div className="shrink-0 text-right">
                          <span className="text-xs font-bold text-[#f0c060]">{oddsStr}</span>
                        </div>

                        {/* Lock icon */}
                        <span className={`shrink-0 transition-colors duration-150
                          ${isLocked ? 'text-[#f0c060]' : 'text-white/20'}`}>
                          <LockIcon locked={isLocked} />
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>

              <p className="text-[11px] text-white/20 text-center pt-1">
                All picks are HIGH confidence · Hit &ldquo;Regenerate&rdquo; for a new combo
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
