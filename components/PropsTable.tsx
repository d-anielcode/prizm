'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { ConfidenceBadge } from './ConfidenceBadge'
import type { Prop, StatType, ConfidenceLabel } from '@/types'

const STAT_LABELS: Record<StatType, string> = {
  points: 'PTS',
  rebounds: 'REB',
  assists: 'AST',
  steals: 'STL',
  blocks: 'BLK',
  three_pointers: '3PM',
  pra: 'PRA',
}

export function PropsTable({ props }: { props: Prop[] }) {
  const [search, setSearch] = useState('')
  const [statFilter, setStatFilter] = useState<StatType | 'all'>('all')
  const [labelFilter, setLabelFilter] = useState<ConfidenceLabel | 'all'>('all')
  const [dirFilter, setDirFilter] = useState<'over' | 'under' | 'all'>('all')

  const filtered = useMemo(() => {
    return props.filter((p) => {
      if (search && !p.player_name.toLowerCase().includes(search.toLowerCase())) return false
      if (statFilter !== 'all' && p.stat_type !== statFilter) return false
      if (labelFilter !== 'all' && p.confidence_label !== labelFilter) return false
      if (dirFilter !== 'all' && p.direction !== dirFilter) return false
      return true
    })
  }, [props, search, statFilter, labelFilter, dirFilter])

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <input
          type="text"
          placeholder="Search player..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30"
        />

        <select
          value={statFilter}
          onChange={(e) => setStatFilter(e.target.value as StatType | 'all')}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-white/30"
        >
          <option value="all">All Stats</option>
          {(Object.keys(STAT_LABELS) as StatType[]).map((s) => (
            <option key={s} value={s}>{STAT_LABELS[s]}</option>
          ))}
        </select>

        <select
          value={dirFilter}
          onChange={(e) => setDirFilter(e.target.value as 'over' | 'under' | 'all')}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-white/30"
        >
          <option value="all">Over + Under</option>
          <option value="over">Over only</option>
          <option value="under">Under only</option>
        </select>

        <select
          value={labelFilter}
          onChange={(e) => setLabelFilter(e.target.value as ConfidenceLabel | 'all')}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white focus:outline-none focus:border-white/30"
        >
          <option value="all">All Confidence</option>
          <option value="HIGH">High only</option>
          <option value="MEDIUM">Medium only</option>
          <option value="LOW">Low only</option>
        </select>

        <span className="ml-auto self-center text-sm text-white/40">
          {filtered.length} props
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-white/5 text-white/50 text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left">Player</th>
              <th className="px-4 py-3 text-left">Stat</th>
              <th className="px-4 py-3 text-right">Line</th>
              <th className="px-4 py-3 text-left">Dir</th>
              <th className="px-4 py-3 text-left">Confidence</th>
              <th className="px-4 py-3 text-left">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.map((prop, i) => (
              <tr
                key={prop.id ?? i}
                className="hover:bg-white/5 transition-colors"
              >
                <td className="px-4 py-3 font-medium text-white">
                  <Link
                    href={`/player/${encodeURIComponent(prop.player_name)}`}
                    className="hover:text-blue-400 transition-colors"
                  >
                    {prop.player_name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-white/60">
                  {STAT_LABELS[prop.stat_type] ?? prop.stat_type}
                </td>
                <td className="px-4 py-3 text-right font-mono text-white">
                  {prop.line}
                </td>
                <td className="px-4 py-3">
                  <span className={prop.direction === 'over' ? 'text-blue-400' : 'text-orange-400'}>
                    {prop.direction.toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {prop.confidence_label && prop.confidence_score != null ? (
                    <ConfidenceBadge
                      label={prop.confidence_label}
                      score={prop.confidence_score}
                    />
                  ) : (
                    <span className="text-white/30">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-white/40 text-xs max-w-xs truncate">
                  {prop.confidence_reason ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="py-16 text-center text-white/30">No props match your filters.</div>
        )}
      </div>
    </div>
  )
}
