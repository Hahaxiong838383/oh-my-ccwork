import { cn } from '@/lib/cn'

interface GlowProps {
  className?: string
  color?: string
  size?: string
}

export function Glow({
  className,
  color = 'rgba(59, 130, 246, 0.12)',
  size = '600px',
}: GlowProps) {
  return (
    <div
      className={cn('pointer-events-none absolute', className)}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle, ${color} 0%, transparent 70%)`,
        filter: 'blur(60px)',
      }}
    />
  )
}
