import { cn } from '@/lib/cn'

interface SectionTitleProps {
  label?: string
  title: string
  className?: string
}

export function SectionTitle({ label, title, className }: SectionTitleProps) {
  return (
    <div className={cn('section-title mb-12 md:mb-16', className)}>
      {label && (
        <span className="section-title-label mb-3 block font-mono text-xs uppercase tracking-[0.2em] text-text-secondary">
          {label}
        </span>
      )}
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary md:text-3xl">
        {title}
      </h2>
    </div>
  )
}
