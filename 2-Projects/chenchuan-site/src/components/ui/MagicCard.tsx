'use client'

import { useRef, useState, useCallback } from 'react'
import { cn } from '@/lib/cn'

interface MagicCardProps {
  children: React.ReactNode
  className?: string
  gradientColor?: string
  gradientSize?: number
}

export function MagicCard({
  children,
  className,
  gradientColor = 'rgba(59, 130, 246, 0.15)',
  gradientSize = 250,
}: MagicCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [opacity, setOpacity] = useState(0)

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!ref.current) return
      const rect = ref.current.getBoundingClientRect()
      setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    },
    [],
  )

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setOpacity(1)}
      onMouseLeave={() => setOpacity(0)}
      className={cn(
        'relative overflow-hidden rounded-xl border border-white/[0.06] bg-bg-card transition-transform duration-300 hover:-translate-y-1',
        className,
      )}
    >
      <div
        className="pointer-events-none absolute -inset-px rounded-xl transition-opacity duration-500"
        style={{
          opacity,
          background: `radial-gradient(${gradientSize}px circle at ${position.x}px ${position.y}px, ${gradientColor}, transparent 65%)`,
        }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  )
}
