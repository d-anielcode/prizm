'use client'

import { ResponsiveContainer, LineChart, Line, ReferenceLine } from 'recharts'

interface Props {
  /** Last N game values for this stat (newest first — will be reversed) */
  values: number[]
  /** Prop line to show as reference */
  line: number
  direction: 'over' | 'under'
}

export function PropSparkline({ values, line, direction }: Props) {
  if (values.length < 3) return null

  const data = [...values].reverse().map((v, i) => ({ i, v }))

  return (
    <div className="w-[100px] h-[32px] shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          <ReferenceLine y={line} stroke="rgba(232,168,32,0.4)" strokeDasharray="3 2" />
          <Line
            type="monotone"
            dataKey="v"
            stroke="rgba(255,255,255,0.2)"
            strokeWidth={1.5}
            dot={(props) => {
              const hit = direction === 'over'
                ? props.payload.v > line
                : props.payload.v < line
              return (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={2.5}
                  fill={hit ? '#22c55e' : '#ef4444'}
                  stroke="none"
                />
              )
            }}
            activeDot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
