'use client'

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts'

interface StatChartProps {
  games: { date: string; value: number }[]
  line: number
  statLabel: string
  direction: 'over' | 'under'
}

export function StatChart({ games, line, statLabel, direction }: StatChartProps) {
  const reversed = [...games].reverse() // oldest → newest left to right

  return (
    <div className="w-full h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={reversed} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              background: 'rgba(0,0,0,0.8)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8,
              color: '#fff',
              fontSize: 12,
            }}
            formatter={(val: number) => [`${val} ${statLabel}`, 'Actual']}
          />
          <ReferenceLine
            y={line}
            stroke="rgba(255,255,255,0.3)"
            strokeDasharray="4 4"
            label={{
              value: `Line: ${line}`,
              fill: 'rgba(255,255,255,0.4)',
              fontSize: 10,
              position: 'insideTopRight',
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={direction === 'over' ? '#60a5fa' : '#fb923c'}
            strokeWidth={2}
            dot={(props) => {
              const hit =
                direction === 'over'
                  ? props.payload.value > line
                  : props.payload.value < line
              return (
                <circle
                  key={props.key}
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={hit ? '#22c55e' : '#ef4444'}
                  stroke="none"
                />
              )
            }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
