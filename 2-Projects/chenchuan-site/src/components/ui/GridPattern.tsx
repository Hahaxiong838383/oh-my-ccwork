import { cn } from '@/lib/cn'

interface GridPatternProps {
  className?: string
  cellSize?: number
  strokeColor?: string
}

export function GridPattern({
  className,
  cellSize = 40,
  strokeColor = 'rgba(255,255,255,0.03)',
}: GridPatternProps) {
  return (
    <svg
      className={cn('pointer-events-none absolute inset-0 h-full w-full', className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern
          id="grid"
          width={cellSize}
          height={cellSize}
          patternUnits="userSpaceOnUse"
        >
          <path
            d={`M ${cellSize} 0 L 0 0 0 ${cellSize}`}
            fill="none"
            stroke={strokeColor}
            strokeWidth="0.5"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>
  )
}
