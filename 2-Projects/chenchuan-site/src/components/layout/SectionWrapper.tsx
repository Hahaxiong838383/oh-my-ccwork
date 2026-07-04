import { cn } from '@/lib/cn'

interface SectionWrapperProps {
  children: React.ReactNode
  className?: string
  id?: string
}

export function SectionWrapper({ children, className, id }: SectionWrapperProps) {
  return (
    <section id={id} className={cn('site-section px-6 py-20 md:px-8 md:py-28', className)}>
      <div className="mx-auto max-w-content">{children}</div>
    </section>
  )
}
