'use client'
// v3 — 4-tier presets, game-diverse selection, calibrated probability estimation

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

type Preset = 'double' | 'treble' | 'power' | 'lottery'

interface PresetConfig {
  label:   string
  legs:    number
  tagline: string
  mult:    string
  // Theoretical hit rate range from calibrated v5.7 backtest
  // Assumes top picks avg ~70–78 score — computed from scoreToProbability
  histRange: string
}

const PRESETS: Record<Preset, PresetConfig> = {
  double:  { label: 'Safe',     legs: 2, tagline: 'Safest combo',  mult: '~2–3×',   histRange: '~37–44%' },
  treble:  { label: 'Standard', legs: 3, tagline: 'Balanced',      mult: '~4–8×',   histRange: '~23–28%' },
  power:   { label: 'Power',    legs: 5, tagline: 'Bold swing',    mult: '~10–25×', histRange: '~8–12%'  },
  lottery: { label: 'Lottery',  legs: 8, tagline: 'High risk',     mult: '~30–80×', histRange: '~2–5%'   },
}

// ── Probability calibration ────────────────────────────────────────────────────
// Two anchor points from v5.7 backtest:
//   PLAY tier avg score ~65 → 57.6% hit rate
//   LOCK tier avg score ~74 → 63.5% hit rate
// Linear fit through those two points:
//   p(score) = 0.150 + score × 0.00656
// Clamped to [0.45, 0.80]
function scoreToProbability(score: number): number {
  const p = 0.150 + score * 0.00656
  return Math.min(0.80, Math.max(0.45, p))
}

function americanToDecimal(american: number): number {
  if (american > 0) return american / 100 + 1
  return 100 / Math.abs(american) + 1
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

function propKey(p: Prop) { return `${p.player_name}|${p.stat_type}` }

// ── Smart selection ────────────────────────────────────────────────────────────
// Priority:
//   1. Skip already-locked player keys
//   2. Pass 1 — one pick per game (maximize independence across legs)
//   3. Pass 2 — fill remaining slots from any game
// Within each pass, order is preserved from `eligible` (score-sorted) with
// a small seeded shuffle on the candidate pool to vary results on regenerate.
function selectPicks(eligible: Prop[], n: number, seed: number, locked: Prop[]): Prop[] {
  const lockedKeySet  = new Set(locked.map(propKey))
  const lockedPlayers = new Set(locked.map((p) => p.player_name))
  const lockedGames   = new Set(locked.map((p) => p.game_id).filter(Boolean) as string[])

  const slotsNeeded = n - locked.length
  if (slotsNeeded <= 0) return locked

  // Candidate pool: top eligible excluding locked keys, slightly shuffled for variety
  const raw  = eligible.filter((p) => !lockedKeySet.has(propKey(p))).slice(0, slotsNeeded * 6)
  const pool = seed <= 1 ? raw : seededShuffle(raw, seed)

  const picks: Prop[] = []
  const usedPlayers   = new Set(lockedPlayers)
  const usedGames     = new Set(lockedGames)

  // Pass 1: prefer a different game per leg (independence)
  for (const p of pool) {
    if (picks.length >= slotsNeeded) break
    if (usedPlayers.has(p.player_name)) continue
    if (!usedGames.has(p.game_id ?? '')) {
      picks.push(p)
      usedPlayers.add(p.player_name)
      usedGames.add(p.game_id ?? '')
    }
  }

  // Pass 2: fill remaining (same game OK if we've run out of unique games)
  for (const p of pool) {
    if (picks.length >= slotsNeeded) break
    if (usedPlayers.has(p.player_name)) continue
    if (!picks.some((x) => propKey(x) === propKey(p))) {
      picks.push(p)
      usedPlayers.add(p.player_name)
    }
  }

  return [...locked, ...picks]
}

// ── Label styling ─────────────────────────────────────────────────────────────
function labelStyle(label: string | null) {
  if (label === 'LOCK') return 'text-violet-400 bg-violet-400/10 border-violet-400/25'
  if (label === 'PLAY') return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/25'
  return 'text-white/40 bg-white/5 border-white/10'
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Props { allProps: Prop[] }

export default function ParlayBuilder({ allProps }: Props) {
  const [preset, setPreset]             = useState<Preset>('treble')
  const [enabledStats, setEnabledStats] = useState(new Set(Object.keys(STAT_LABELS)))
  const [parlay, setParlay]             = useState<Prop[] | null>(null)
  const [seed, setSeed]                 = useState(1)
  const [lockedKeys, setLockedKeys]     = useState(new Set<string>())
  const [hovered, setHovered]           = useState<string | null>(null)

  // Deduplicated, score-sorted eligible pool (LOCK + PLAY only)
  const eligible = useMemo(() => {
    const seen = new Set<string>()
    return allProps
      .filter((p) =>
        (p.confidence_label === 'LOCK' || p.confidence_label === 'PLAY') &&
        enabledStats.has(p.stat_type)
      )
      .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
      .filter((p) => {
        const k = propKey(p)
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
  }, [allProps, enabledStats])

  const cfg = PRESETS[preset]

  const build = useCallback(() => {
    const locked = (parlay ?? []).filter((p) => lockedKeys.has(propKey(p)))
    const result = selectPicks(eligible, cfg.legs, seed, locked)
    setParlay(result)
    setSeed((s) => s + 1)
  }, [eligible, cfg.legs, seed, parlay, lockedKeys])

  const toggleLock = useCallback((p: Prop) => {
    setLockedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(propKey(p))) next.delete(propKey(p))
      else next.add(propKey(p))
      return next
    })
  }, [])

  const toggleStat = useCallback((stat: string) => {
    setEnabledStats((prev) => {
      const next = new Set(prev)
      if (next.has(stat) && next.size > 1) next.delete(stat)
      else next.add(stat)
      return next
    })
    setParlay(null)
    setLockedKeys(new Set())
  }, [])

  const switchPreset = useCallback((p: Preset) => {
    setPreset(p)
    setParlay(null)
    setLockedKeys(new Set())
  }, [])

  // Derived stats for the current parlay
  const picks       = parlay ?? []
  const probs       = picks.map((p) => scoreToProbability(p.confidence_score ?? 62))
  const jointProb   = probs.reduce((acc, p) => acc * p, 1)
  const multiplier  = picks.length > 0
    ? picks.reduce((acc, p) => acc * americanToDecimal(p.odds ?? -110), 1)
    : null
  const uniqueGames = new Set(picks.map((p) => p.game_id).filter(Boolean)).size
  const lockedCount = picks.filter((p) => lockedKeys.has(propKey(p))).length

  const PRESET_ORDER: Preset[] = ['double', 'treble', 'power', 'lottery']
  const PRESET_COLORS: Record<Preset, { active: string; dot: string }> = {
    double:  { active: 'bg-emerald-500/12 border-emerald-400/35 text-emerald-300', dot: 'bg-emerald-400' },
    treble:  { active: 'bg-[#e8a820]/10 border-[#e8a820]/35 text-[#f0c060]',       dot: 'bg-[#f0c060]'  },
    power:   { active: 'bg-orange-500/10 border-orange-400/35 text-orange-300',     dot: 'bg-orange-400' },
    lottery: { active: 'bg-red-500/10 border-red-400/35 text-red-300',              dot: 'bg-red-400'    },
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-black text-white tracking-tight">AI Parlay Builder</h2>
        <span className="text-[11px] text-[#f0c060]/70 bg-[#e8a820]/8 border border-[#e8a820]/20 rounded-full px-2.5 py-0.5 font-semibold tracking-wide">
          LOCK &amp; PLAY · Game-diverse picks
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* ── Controls ─────────────────────────────────────────────── */}
        <div className="lg:col-span-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
          <div className="h-px w-full bg-gradient-to-r from-transparent via-[#e8a820]/40 to-transparent" />
          <div className="p-5 flex flex-col gap-5">

            {/* Preset picker */}
            <div>
              <p className="text-[11px] text-white/35 uppercase tracking-widest mb-2.5">Parlay Type</p>
              <div className="grid grid-cols-2 gap-2">
                {PRESET_ORDER.map((key) => {
                  const c = PRESETS[key]
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
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] opacity-45">{c.tagline}</span>
                        <span className="text-[10px] font-bold opacity-55">{c.mult}</span>
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

            {/* Historical context */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] text-white/30 uppercase tracking-widest">Historical hit rate</p>
                <p className="text-sm font-black text-white/55">{cfg.histRange}</p>
              </div>
              <p className="text-[10px] text-white/20 leading-snug">
                {cfg.legs}-leg LOCK/PLAY parlays · calibrated from v5.7 backtest
                (63.5% LOCK · 57.6% PLAY individual hit rates)
              </p>
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

        {/* ── Result ───────────────────────────────────────────────── */}
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
                <p className="text-white/50 font-semibold text-sm">Select a type and hit Build</p>
                <p className="text-white/25 text-xs mt-1 max-w-xs">
                  Picks are chosen by confidence score and prefer
                  different games to maximize independence between legs.
                </p>
              </div>
            </div>

          ) : picks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-10">
              <p className="text-white/30 text-sm text-center">
                Not enough LOCK or PLAY picks for the selected stats.<br />
                Try enabling more stat types.
              </p>
            </div>

          ) : (
            <div className="flex-1 flex flex-col p-5 gap-4">

              {/* ── Stats bar ─────────────────────────────────────── */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest">Est. Hit Chance</p>
                  <p className={`text-3xl font-black mt-0.5 ${
                    jointProb >= 0.35 ? 'text-emerald-400' :
                    jointProb >= 0.20 ? 'text-[#f0c060]' : 'text-red-400'
                  }`}>
                    {Math.round(jointProb * 100)}%
                  </p>
                  <p className="text-[10px] text-white/20 mt-0.5">this parlay</p>
                </div>
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest">Multiplier</p>
                  <p className="text-3xl font-black text-white/60 mt-0.5">{multiplier!.toFixed(1)}×</p>
                  <p className="text-[10px] text-white/20 mt-0.5">at -110 avg</p>
                </div>
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-widest">Games</p>
                  <p className="text-3xl font-black text-white/60 mt-0.5">{uniqueGames}</p>
                  <p className="text-[10px] text-white/20 mt-0.5">of {picks.length} legs</p>
                </div>
              </div>

              <div className="h-px bg-white/[0.06]" />

              {/* ── Picks ─────────────────────────────────────────── */}
              <p className="text-[11px] text-white/25">
                Click a pick to lock it on regenerate · Hover for analysis
              </p>

              <div className="flex flex-col gap-2 flex-1">
                {picks.map((prop, i) => {
                  const key      = propKey(prop)
                  const isLocked = lockedKeys.has(key)
                  const isHovered = hovered === `${key}-${i}`
                  const pHit = scoreToProbability(prop.confidence_score ?? 62)
                  const oddsStr = prop.odds != null
                    ? prop.odds > 0 ? `+${prop.odds}` : `${prop.odds}`
                    : '−110'

                  return (
                    <div
                      key={prop.id ?? `${key}-${i}`}
                      className="relative"
                      onMouseEnter={() => setHovered(`${key}-${i}`)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      {/* Tooltip */}
                      {isHovered && prop.confidence_reason && (
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
                        {/* Leg number */}
                        <span className="text-xs font-black text-white/15 w-4 shrink-0 tabular-nums">{i + 1}</span>

                        {/* Player + pick */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-white truncate">{prop.player_name}</p>
                          <p className="text-xs text-white/40 mt-0.5">
                            <span className={`font-bold ${prop.direction === 'over' ? 'text-emerald-400' : 'text-red-400'}`}>
                              {prop.direction.toUpperCase()}
                            </span>
                            {' '}{prop.line} {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                            <span className="ml-2 text-[#f0c060]/60 font-semibold">{oddsStr}</span>
                          </p>
                        </div>

                        {/* Individual hit estimate */}
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-black text-white/55 tabular-nums">{Math.round(pHit * 100)}%</p>
                          <p className="text-[9px] text-white/20">hit est.</p>
                        </div>

                        {/* Confidence badge */}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${labelStyle(prop.confidence_label ?? null)}`}>
                          {prop.confidence_score != null ? Math.round(prop.confidence_score) : '—'}
                          {' '}{prop.confidence_label}
                        </span>

                        {/* Lock icon */}
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

              {/* Footer */}
              <p className="text-[10px] text-white/15 text-center leading-snug">
                Picks prefer different games for independence · Hit chance = product of individual estimates ·
                Calibrated from v5.7 backtest
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
