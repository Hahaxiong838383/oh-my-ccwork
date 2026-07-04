interface TrendPoint {
  date: string
  pv: number
  uv: number
}

interface Props {
  data: TrendPoint[]
  width?: number
  height?: number
}

// 纯 SVG 双折线图（PV/UV）— 零外部依赖，避免引入 recharts ~300KB
export function TrendChart({ data, width = 720, height = 240 }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-60 items-center justify-center rounded border border-white/10 bg-white/[0.02] text-sm text-white/40">
        暂无访问数据
      </div>
    )
  }

  const padding = { top: 20, right: 30, bottom: 32, left: 44 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom

  const maxValue = Math.max(
    1,
    ...data.flatMap((d) => [d.pv, d.uv]),
  )

  const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW
  const yScale = (v: number): number => innerH - (v / maxValue) * innerH

  const pvPath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${padding.left + i * xStep} ${padding.top + yScale(d.pv)}`)
    .join(' ')
  const uvPath = data
    .map((d, i) => `${i === 0 ? 'M' : 'L'} ${padding.left + i * xStep} ${padding.top + yScale(d.uv)}`)
    .join(' ')

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(maxValue * p))

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="block w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Y 轴刻度 + 网格线 */}
      {yTicks.map((v, i) => {
        const y = padding.top + yScale(v)
        return (
          <g key={`y-${i}`}>
            <line
              x1={padding.left}
              x2={padding.left + innerW}
              y1={y}
              y2={y}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
            <text
              x={padding.left - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={10}
              fill="rgba(255,255,255,0.4)"
              fontFamily="JetBrains Mono, ui-monospace, monospace"
            >
              {v}
            </text>
          </g>
        )
      })}

      {/* X 轴标签（日期） */}
      {data.map((d, i) => {
        // 数据点多时跳着显示
        if (data.length > 7 && i % Math.ceil(data.length / 7) !== 0 && i !== data.length - 1) {
          return null
        }
        const x = padding.left + i * xStep
        const label = d.date.slice(5) // MM-DD
        return (
          <text
            key={`x-${i}`}
            x={x}
            y={padding.top + innerH + 18}
            textAnchor="middle"
            fontSize={10}
            fill="rgba(255,255,255,0.5)"
            fontFamily="JetBrains Mono, ui-monospace, monospace"
          >
            {label}
          </text>
        )
      })}

      {/* PV 折线 */}
      <path d={pvPath} fill="none" stroke="#7dd3fc" strokeWidth={2} />
      {data.map((d, i) => (
        <circle
          key={`pv-${i}`}
          cx={padding.left + i * xStep}
          cy={padding.top + yScale(d.pv)}
          r={3}
          fill="#7dd3fc"
        />
      ))}

      {/* UV 折线 */}
      <path d={uvPath} fill="none" stroke="#a78bfa" strokeWidth={2} strokeDasharray="4 4" />
      {data.map((d, i) => (
        <circle
          key={`uv-${i}`}
          cx={padding.left + i * xStep}
          cy={padding.top + yScale(d.uv)}
          r={3}
          fill="#a78bfa"
        />
      ))}

      {/* 图例 */}
      <g transform={`translate(${padding.left}, ${padding.top - 8})`}>
        <circle cx={6} cy={0} r={4} fill="#7dd3fc" />
        <text x={16} y={4} fontSize={11} fill="rgba(255,255,255,0.7)" fontFamily="JetBrains Mono, ui-monospace, monospace">PV</text>
        <circle cx={56} cy={0} r={4} fill="#a78bfa" />
        <text x={66} y={4} fontSize={11} fill="rgba(255,255,255,0.7)" fontFamily="JetBrains Mono, ui-monospace, monospace">UV</text>
      </g>
    </svg>
  )
}
