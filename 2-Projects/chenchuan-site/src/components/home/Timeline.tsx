'use client'

import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { MagicCard } from '@/components/ui/MagicCard'
import { Tag } from '@/components/shared/Tag'
import type { TimelineItem } from '@/data/timeline'

interface Props {
  timeline: TimelineItem[]
}

export function Timeline({ timeline }: Props) {
  return (
    <SectionWrapper id="timeline">
      <SectionTitle label="职业历程" title="一路走来" />

      <div className="relative">
        <div className="absolute left-0 top-0 hidden h-full w-px bg-bg-secondary md:left-[120px] md:block" />

        <div className="space-y-10">
          {timeline.map((item, i) => (
            <BlurFade key={item.period} delay={i * 0.1}>
              <div className="grid gap-4 md:grid-cols-[120px_1fr] md:gap-8">
                <div className="relative font-mono text-sm text-text-muted md:text-right">
                  <span>{item.period}</span>
                  <div className="absolute -right-[4.5px] top-1.5 hidden h-2 w-2 rounded-full border-2 border-bg-primary bg-accent md:block" />
                </div>

                <MagicCard
                  className="timeline-card md:ml-6"
                  gradientColor="rgba(91, 167, 255, 0.12)"
                >
                  <div className="p-5">
                    <div className="mb-1 text-base font-semibold text-text-primary">
                      {item.company}
                    </div>
                    <div className="mb-3 text-sm text-accent">{item.role}</div>
                    <p className="mb-4 text-sm leading-relaxed text-text-secondary">
                      {item.description}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {item.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </div>
                  </div>
                </MagicCard>
              </div>
            </BlurFade>
          ))}
        </div>
      </div>
    </SectionWrapper>
  )
}
