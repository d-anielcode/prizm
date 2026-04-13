'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ConfidenceBadge } from './ConfidenceBadge'
import type { ConfidenceLabel } from '@/types'

interface GameInfo {
  game_id: string
  home_team: string | null
  away_team: string | null
  commence_time: string | null
  prop_count: number
}

interface PropSummary {
  player_name: string
  stat_type: string
  line: number
  direction: 'over' | 'under'
  confidence_score: number | null
  confidence_label: string | null
  game_id: string
  team?: string | null
}

const STAT_LABELS: Record<string, string> = {
  points: 'PTS', rebounds: 'REB', assists: 'AST', steals: 'STL',
  blocks: 'BLK', three_pointers: '3PM', pra: 'PRA',
}

function teamAbbr(name: string | null): string {
  if (!name) return '???'
  const ABBR: Record<string, string> = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
    'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
    'LA Clippers': 'LAC', 'LA Lakers': 'LAL',
  }
  return ABBR[name] ?? name.slice(0, 3).toUpperCase()
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
  }) + ' ET'
}

export function HomeContent({
  games,
  allProps,
  stale,
  gameDay,
}: {
  games: GameInfo[]
  allProps: PropSummary[]
  stale: boolean
  gameDay: string
}) {
  const [selectedGameId, setSelectedGameId] = useState<string | null>(games[0]?.game_id ?? null)

  const lock = allProps.filter((p) => p.confidence_label === 'LOCK').length
  const play = allProps.filter((p) => p.confidence_label === 'PLAY').length
  const lean = allProps.filter((p) => p.confidence_label === 'LEAN').length
  const fade = allProps.filter((p) => p.confidence_label === 'FADE').length

  const selectedGame = games.find((g) => g.game_id === selectedGameId)
  const gameProps = allProps
    .filter((p) => p.game_id === selectedGameId && p.confidence_label !== 'FADE')
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
      {/* Stale warning */}
      {stale && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FFB800]/10 border border-[#FFB800]/20 text-[#FFB800] text-xs">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#FFB800] animate-pulse shrink-0" />
          Showing last cached slate — today&apos;s lines not yet available. Updates automatically by 8 AM ET.
        </div>
      )}

      {/* Page heading */}
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-bold text-foreground tracking-tight">{gameDay} Slate</h1>
        <span className="text-[var(--text-secondary)] text-sm">{games.length} games</span>
      </div>

      {/* Game strip */}
      {games.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:-mx-6 sm:px-6 scrollbar-none">
          {games.map((game) => {
            const isActive = game.game_id === selectedGameId
            return (
              <button
                key={game.game_id}
                onClick={() => setSelectedGameId(game.game_id)}
                className={[
                  'flex-shrink-0 rounded-xl px-4 py-2.5 text-center transition-all duration-150 cursor-pointer min-w-[130px]',
                  isActive
                    ? 'bg-primary text-white shadow-[0_0_12px_rgba(108,92,231,0.25)]'
                    : 'bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)] hover:border-primary/40',
                ].join(' ')}
              >
                <div className="text-sm font-bold">{teamAbbr(game.away_team)} vs {teamAbbr(game.home_team)}</div>
                <div className={`text-[10px] mt-0.5 ${isActive ? 'text-white/70' : 'text-[var(--text-tertiary)]'}`}>
                  {formatTime(game.commence_time)}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* KPI tier summary */}
      <div className="flex gap-2">
        {[
          { count: lock, label: 'LOCK', color: '#00D68F' },
          { count: play, label: 'PLAY', color: '#FFB800' },
          { count: lean, label: 'LEAN', color: '#3B82F6' },
          { count: fade, label: 'FADE', color: '#FF4757' },
        ].map(({ count, label, color }) => (
          <div
            key={label}
            className="flex-1 rounded-lg py-2 text-center"
            style={{ background: `${color}15` }}
          >
            <div className="text-lg font-bold font-mono" style={{ color }}>{count}</div>
            <div className="text-[10px] text-[var(--text-secondary)] font-semibold">{label}</div>
          </div>
        ))}
      </div>

      {/* Props for selected game */}
      {selectedGame && gameProps.length > 0 && (
        <div>
          <div className="text-xs text-[var(--text-secondary)] uppercase tracking-wider font-semibold mb-3">
            {teamAbbr(selectedGame.away_team)} vs {teamAbbr(selectedGame.home_team)} &middot; Top Props
          </div>
          <div className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-xl overflow-hidden shadow-[var(--shadow-card)]">
            {gameProps.map((prop, i) => (
              <Link
                key={`${prop.player_name}-${prop.stat_type}-${prop.line}-${prop.direction}`}
                href={`/props?search=${encodeURIComponent(prop.player_name)}`}
                className={[
                  'flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-surface-2)] transition-colors duration-150',
                  i < gameProps.length - 1 ? 'border-b border-[var(--border-subtle)]' : '',
                ].join(' ')}
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-foreground">{prop.player_name}</span>
                  <span className="text-xs text-[var(--text-secondary)] font-mono">
                    {prop.direction === 'over' ? 'O' : 'U'} {prop.line} {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                  </span>
                </div>
                {prop.confidence_label && prop.confidence_score != null && (
                  <ConfidenceBadge label={prop.confidence_label as ConfidenceLabel} score={prop.confidence_score} />
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      {selectedGame && gameProps.length === 0 && (
        <div className="py-12 text-center text-[var(--text-tertiary)] text-sm">
          No scored props for this game yet.
        </div>
      )}

      {games.length === 0 && (
        <div className="py-16 text-center text-[var(--text-tertiary)]">
          No upcoming games found. Props refresh automatically by 8 AM ET.
        </div>
      )}
    </div>
  )
}
