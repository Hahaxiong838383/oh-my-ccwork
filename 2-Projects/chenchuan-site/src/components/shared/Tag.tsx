import { cn } from '@/lib/cn'

interface TagProps {
  children: React.ReactNode
  className?: string
  variant?: 'default' | 'accent' | 'teal'
}

const variants = {
  default: 'border-border text-text-secondary',
  accent: 'border-accent/20 bg-accent/5 text-accent',
  teal: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400',
}

export function Tag({ children, className, variant = 'default' }: TagProps) {
  return (
    <span
      className={cn(
        'tag-chip inline-block rounded-sm border px-2 py-0.5 font-mono text-[11px]',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}
