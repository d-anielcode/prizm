'use client'
// v4 — Same Game tab (auto-curated SGPs) + Builder tab (cross-game), conservative multipliers

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

type Mode   = 'sgp' | 'multi'
type Preset = 'double' | 'treble' | 'power' | 'lottery'

interface SGPSlate {
  gameId:       string
  homeTeam:     string | null
  awayTeam:     string | null
  commenceTime: string | null
  legs:         Prop[]
}

const PRESETS: Record<Preset, { label: string; legs: number; tagline: string }> = {
  double:  { label: 'Safe',     legs: 2, tagline: '2 legs · cross-game' },
  treble:  { label: 'Standard', legs: 3, tagline: '3 legs · cross-game' },
  power:   { label: 'Power',    legs: 5, tagline: '5 legs · cross-game' },
  lottery: { label: 'Lottery',  legs: 8, tagline: '8 legs · cross-game' },
}

function propKey(p: Prop) { return `${p.player_name}|${p.stat_type}` }

// Conservative multiplier: product of decimal odds, minus a book-hold discount.
// SGP legs share the same game so sportsbooks apply extra correlation juice (~40% off).
// Cross-game parlays face ~20% hold vs true odds.
function calcMultiplier(props: Prop[], isSGP: boolean): number {
  if (props.length === 0) return 1
  const product = props.reduce((acc, p) => {
    const o = p.odds ?? -110
    const dec = o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1
    return acc * dec
  }, 1)
  return product * (isSGP ? 0.60 : 0.80)
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

// Two-pass selection: pass 1 = one per game (independence), pass 2 = fill remaining
function selectPicks(eligible: Prop[], n: number, seed: number, locked: Prop[]): Prop[] {
  const lockedKeySet  = new Set(locked.map(propKey))
  const lockedPlayers = new Set(locked.map((p) => p.player_name))
  const lockedGames   = new Set(locked.map((p) => p.game_id).filter(Boolean) as string[])

  const slotsNeeded = n - locked.length
  if (slotsNeeded <= 0) return locked

  const raw  = eligible.filter((p) => !lockedKeySet.has(propKey(p))).slice(0, slotsNeeded * 6)
  const pool = seed <= 1 ? raw : seededShuffle(raw, seed)

  const picks: Prop[] = []
  const usedPlayers   = new Set(lockedPlayers)
  const usedGames     = new Set(lockedGames)

  for (const p of pool) {
    if (picks.length >= slotsNeeded) break
    if (usedPlayers.has(p.player_name)) continue
    if (!usedGames.has(p.game_id ?? '')) {
      picks.push(p); usedPlayers.add(p.player_name); usedGames.add(p.game_id ?? '')
    }
  }
  for (const p of pool) {
    if (picks.length >= slotsNeeded) break
    if (usedPlayers.has(p.player_name)) continue
    if (!picks.some((x) => propKey(x) === propKey(p))) {
      picks.push(p); usedPlayers.add(p.player_name)
    }
  }

  return [...locked, ...picks]
}

function labelStyle(label: string | null) {
  if (label === 'LOCK') return 'text-violet-400 bg-violet-400/10 border-violet-400/25'
  if (label === 'PLAY') return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
  return 'text-white/40 bg-white/5 border-white/10'
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET'
}

function oddsStr(odds: number | undefined): string {
  if (odds == null) return '−110'
  return odds > 0 ? `+${odds}` : `${odds}`
}

interface Props { allProps: Prop[] }

export default function ParlayBuilder({ allProps }: Props) {
  const [mode, setMode]             = useState<Mode>('sgp')
  const [preset, setPreset]         = useState<Preset>('treble')
  const [parlay, setParlay]         = useState<Prop[] | null>(null)
  const [seed, setSeed]             = useState(1)
  const [lockedKeys, setLockedKeys] = useState(new Set<string>())
  const [hovered, setHovered]       = useState<string | null>(null)

  // Eligible pool: LOCK + PLAY only, deduped by player+stat, sorted by score
  const eligible = useMemo(() => {
    const seen = new Set<string>()
    return allProps
      .filter((p) => p.confidence_label === 'LOCK' || p.confidence_label === 'PLAY')
      .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
      .filter((p) => { const k = propKey(p); if (seen.has(k)) return false; seen.add(k); return true })
  }, [allProps])

  // SGP slates: group by game, pick 2–3 best legs from ≥2 players, mixing teams
  const sgpSlates = useMemo<SGPSlate[]>(() => {
    const byGame = new Map<string, Prop[]>()
    for (const p of eligible) {
      const gid = p.game_id ?? ''; if (!gid) continue
      if (!byGame.has(gid)) byGame.set(gid, [])
      byGame.get(gid)!.push(p)
    }

    const slates: SGPSlate[] = []
    for (const [gameId, props] of byGame) {
      // Best single prop per player (avoid doubling up on a player)
      const bestPerPlayer = new Map<string, Prop>()
      for (const p of props) {
        const ex = bestPerPlayer.get(p.player_name)
        if (!ex || (p.confidence_score ?? 0) > (ex.confidence_score ?? 0)) bestPerPlayer.set(p.player_name, p)
      }
      if (bestPerPlayer.size < 2) continue

      const all = [...bestPerPlayer.values()].sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
      const sample   = all[0]
      const homeTeam = sample?.home_team ?? null
      const awayTeam = sample?.away_team ?? null

      // Try to include at least one prop from each team for matchup diversity
      const home = all.filter((p) => p.team === homeTeam)
      const away = all.filter((p) => p.team === awayTeam)
      let legs: Prop[]
      if (home.length > 0 && away.length > 0) {
        const rest = all.filter((p) => p !== home[0] && p !== away[0])
        legs = [home[0], away[0], ...rest].slice(0, 3)
      } else {
        legs = all.slice(0, 3)
      }
      if (legs.length < 2) continue

      slates.push({ gameId, homeTeam, awayTeam, commenceTime: sample?.commence_time ?? null, legs })
    }

    // Best slates first (by avg confidence score)
    return slates.sort((a, b) => {
      const avgA = a.legs.reduce((s, p) => s + (p.confidence_score ?? 0), 0) / a.legs.length
      const avgB = b.legs.reduce((s, p) => s + (p.confidence_score ?? 0), 0) / b.legs.length
      return avgB - avgA
    })
  }, [eligible])

  const cfg         = PRESETS[preset]
  const picks       = parlay ?? []
  const lockedCount = picks.filter((p) => lockedKeys.has(propKey(p))).length
  const builderMult = picks.length > 0 ? calcMultiplier(picks, false) : null

  const build = useCallback(() => {
    const locked = (parlay ?? []).filter((p) => lockedKeys.has(propKey(p)))
    setParlay(selectPicks(eligible, cfg.legs, seed, locked))
    setSeed((s) => s + 1)
  }, [eligible, cfg.legs, seed, parlay, lockedKeys])

  const toggleLock = useCallback((p: Prop) => {
    setLockedKeys((prev) => { const next = new Set(prev); next.has(propKey(p)) ? next.delete(propKey(p)) : next.add(propKey(p)); return next })
  }, [])

  const switchPreset = useCallback((p: Preset) => { setPreset(p); setParlay(null); setLockedKeys(new Set()) }, [])

  const PRESET_ORDER: Preset[] = ['double', 'treble', 'power', 'lottery']
  const PRESET_COLORS: Record<Preset, { active: string; dot: string }> = {
    double:  { active: 'bg-emerald-500/12 border-emerald-400/35 text-emerald-300', dot: 'bg-emerald-400' },
    treble:  { active: 'bg-[#e8a820]/10 border-[#e8a820]/35 text-[#f0c060]',       dot: 'bg-[#f0c060]'  },
    power:   { active: 'bg-orange-500/10 border-orange-400/35 text-orange-300',     dot: 'bg-orange-400' },
    lottery: { active: 'bg-red-500/10 border-red-400/35 text-red-300',              dot: 'bg-red-400'    },
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Header + mode tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-black text-white tracking-tight">Parlay Builder</h2>
          <span className="text-[11px] text-[#f0c060]/70 bg-[#e8a820]/8 border border-[#e8a820]/20 rounded-full px-2.5 py-0.5 font-semibold tracking-wide">
            LOCK &amp; PLAY
          </span>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-white/[0.03] border border-white/[0.06] rounded-xl">
          {(['sgp', 'multi'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-4 py-1.5 text-sm font-bold transition-all duration-150
                ${mode === m
                  ? 'bg-white/[0.08] text-white border border-white/[0.10]'
                  : 'text-white/35 hover:text-white/55'}`}
            >
              {m === 'sgp' ? 'Same Game' : 'Builder'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Same Game Parlay Mode ─────────────────────────────────────────── */}
      {mode === 'sgp' && (
        <div className="flex flex-col gap-3">
          {sgpSlates.length === 0 ? (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-12 text-center">
              <p className="text-white/30 text-sm">No games with multiple LOCK/PLAY props available.</p>
            </div>
          ) : sgpSlates.map((slate) => {
            const mult     = calcMultiplier(slate.legs, true)
            const matchup  = slate.awayTeam && slate.homeTeam
              ? `${slate.awayTeam} @ ${slate.homeTeam}`
              : slate.gameId

            return (
              <div key={slate.gameId} className="rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/30 to-transparent" />
                <div className="p-4 sm:p-5 flex flex-col gap-3">

                  {/* Game header */}
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-white">{matchup}</p>
                      {slate.commenceTime && (
                        <p className="text-[11px] text-white/30 mt-0.5">{formatTime(slate.commenceTime)}</p>
                      )}
                      <p className="text-[11px] text-white/20 mt-1">{slate.legs.length}-leg SGP</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-white/30 uppercase tracking-widest">Est. Payout</p>
                      <p className="text-2xl font-black text-[#f0c060]">~{mult.toFixed(1)}×</p>
                      <p className="text-[10px] text-white/20">incl. SGP discount</p>
                    </div>
                  </div>

                  {/* Legs */}
                  <div className="flex flex-col gap-1.5">
                    {slate.legs.map((prop, i) => (
                      <div
                        key={`${propKey(prop)}-${i}`}
                        className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white/[0.03] border border-white/[0.06]"
                      >
                        <span className="text-xs font-black text-white/15 w-3 shrink-0">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-white truncate">
                            {prop.player_name}
                            <span className="text-[11px] text-white/25 font-normal ml-1.5">{prop.team}</span>
                          </p>
                          <p className="text-xs text-white/40 mt-0.5">
                            <span className={`font-bold ${prop.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {prop.direction.toUpperCase()}
                            </span>
                            {' '}{prop.line} {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                            <span className="ml-2 text-[#f0c060]/50 font-semibold">{oddsStr(prop.odds)}</span>
                          </p>
                        </div>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${labelStyle(prop.confidence_label ?? null)}`}>
                          {prop.confidence_score != null ? Math.round(prop.confidence_score) : '—'} {prop.confidence_label}
                        </span>
                      </div>
                    ))}
                  </div>

                  <p className="text-[10px] text-white/15">
                    Payout estimate applies ~40% discount for same-game correlation and sportsbook hold.
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Cross-Game Parlay Builder ─────────────────────────────────────── */}
      {mode === 'multi' && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

          {/* Controls */}
          <div className="lg:col-span-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
            <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />
            <div className="p-5 flex flex-col gap-5">

              {/* Preset picker */}
              <div>
                <p className="text-[11px] text-white/35 uppercase tracking-widest mb-2.5">Parlay Type</p>
                <div className="grid grid-cols-2 gap-2">
                  {PRESET_ORDER.map((key) => {
                    const c      = PRESETS[key]
                    const active = preset === key
                    const { active: activeClass, dot } = PRESET_COLORS[key]
                    return (
                      <button
                        key={key}
                        onClick={() => switchPreset(key)}
                        className={`flex flex-col gap-0.5 rounded-xl px-3 py-2.5 border text-left transition-all duration-200
                          ${active
                            ? activeClass
                            : 'bg-white/[0.02] border-white/[0.06] text-white/35 hover:border-white/12 hover:text-white/55'}`}
                      >
                        <div className="flex items-center gap-1.5">
                          {active && <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />}
                          <span className="text-sm font-black">{c.label}</span>
                          <span className="text-[10px] opacity-55 ml-auto">{c.legs} legs</span>
                        </div>
                        <span className="text-[10px] opacity-45">{c.tagline}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <p className="text-[11px] text-white/20">{eligible.length} eligible picks today</p>

              <button
                onClick={build}
                disabled={eligible.length < cfg.legs - lockedCount}
                className="w-full rounded-xl py-3.5 font-black text-sm transition-all duration-200
                  bg-gradient-to-r from-[#e8a820] to-[#f5d060] text-black
                  hover:shadow-[0_0_24px_rgba(232,168,32,0.35)]
                  disabled:opacity-25 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                {parlay
                  ? lockedCount > 0 ? `Regenerate · ${lockedCount} locked` : 'Regenerate'
                  : `Build ${cfg.label}`}
              </button>
            </div>
          </div>

          {/* Result panel */}
          <div className="lg:col-span-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden flex flex-col">
            <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />

            {!parlay ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 p-10 text-center">
                <p className="text-white/50 font-semibold text-sm">Select a type and hit Build</p>
                <p className="text-white/25 text-xs max-w-xs">
                  Picks are ranked by confidence and prefer different games to maximize independence between legs.
                </p>
              </div>
            ) : picks.length === 0 ? (
              <div className="flex-1 flex items-center justify-center p-10">
                <p className="text-white/30 text-sm text-center">Not enough LOCK or PLAY picks today.</p>
              </div>
            ) : (
              <div className="flex-1 flex flex-col p-5 gap-4">

                {/* Stats bar */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest">Est. Multiplier</p>
                    <p className="text-3xl font-black text-[#f0c060] mt-0.5">~{builderMult!.toFixed(1)}×</p>
                    <p className="text-[10px] text-white/20 mt-0.5">after ~20% book hold</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-white/30 uppercase tracking-widest">Games Spanned</p>
                    <p className="text-3xl font-black text-white/60 mt-0.5">
                      {new Set(picks.map((p) => p.game_id).filter(Boolean)).size}
                    </p>
                    <p className="text-[10px] text-white/20 mt-0.5">of {picks.length} legs</p>
                  </div>
                </div>

                <div className="h-px bg-white/[0.06]" />

                <p className="text-[11px] text-white/25">Click a pick to lock it on regenerate · Hover for analysis</p>

                {/* Pick rows */}
                <div className="flex flex-col gap-2 flex-1">
                  {picks.map((prop, i) => {
                    const key      = propKey(prop)
                    const isLocked = lockedKeys.has(key)
                    const isHov    = hovered === `${key}-${i}`

                    return (
                      <div
                        key={prop.id ?? `${key}-${i}`}
                        className="relative"
                        onMouseEnter={() => setHovered(`${key}-${i}`)}
                        onMouseLeave={() => setHovered(null)}
                      >
                        {/* Hover tooltip */}
                        {isHov && prop.confidence_reason && (
                          <div className="absolute bottom-full left-0 right-0 mb-2 z-50 pointer-events-none">
                            <div className="rounded-xl border border-white/[0.12] bg-[#0d1320]/95 backdrop-blur-sm px-4 py-3 shadow-2xl">
                              <p className="text-xs text-white/60 leading-relaxed">{prop.confidence_reason}</p>
                              <div className="absolute left-6 top-full w-0 h-0
                                border-l-[6px] border-l-transparent
                                border-r-[6px] border-r-transparent
                                border-t-[6px] border-t-[#0d1320]" />
                            </div>
                          </div>
                        )}

                        <div
                          onClick={() => toggleLock(prop)}
                          className={`flex items-center gap-3 rounded-xl px-4 py-3 border transition-all duration-150 cursor-pointer select-none
                            ${isLocked
                              ? 'bg-[#e8a820]/6 border-[#e8a820]/30'
                              : 'bg-white/[0.03] border-white/[0.06] hover:border-white/12 hover:bg-white/[0.05]'}`}
                        >
                          <span className="text-xs font-black text-white/15 w-4 shrink-0 tabular-nums">{i + 1}</span>

                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-white truncate">{prop.player_name}</p>
                            <p className="text-xs text-white/40 mt-0.5">
                              <span className={`font-bold ${prop.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}`}>
                                {prop.direction.toUpperCase()}
                              </span>
                              {' '}{prop.line} {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                              <span className="ml-2 text-[#f0c060]/60 font-semibold">{oddsStr(prop.odds)}</span>
                            </p>
                          </div>

                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${labelStyle(prop.confidence_label ?? null)}`}>
                            {prop.confidence_score != null ? Math.round(prop.confidence_score) : '—'} {prop.confidence_label}
                          </span>

                          <span className={`shrink-0 transition-colors ${isLocked ? 'text-[#f0c060]' : 'text-white/20'}`}>
                            {isLocked ? (
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                <path fillRule="evenodd" clipRule="evenodd"
                                  d="M12 1a5 5 0 00-5 5v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V10a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 7V6a3 3 0 10-6 0v2h6zm-3 4a1 1 0 011 1v3a1 1 0 11-2 0v-3a1 1 0 011-1z" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                                <rect x="5" y="11" width="14" height="11" rx="2" />
                                <path strokeLinecap="round" d="M8 11V7a4 4 0 017.75-1.4" />
                              </svg>
                            )}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <p className="text-[10px] text-white/15 text-center">
                  Picks prefer different games for independence · Est. multiplier after ~20% book hold
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
