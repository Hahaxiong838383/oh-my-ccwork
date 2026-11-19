'use client'

import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { profile } from '@/data/profile'

export function KeyWins() {
  return (
    <SectionWrapper>
      <SectionTitle label="项目成果" title="做成过的事" />
      <div className="grid gap-3 md:grid-cols-2">
        {profile.keyWins.map((win, i) => (
          <BlurFade key={win} delay={i * 0.06}>
            <div className="flex items-start gap-3 rounded-lg border border-border bg-bg-card px-5 py-4">
              <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
              <span className="text-sm text-text-secondary">{win}</span>
            </div>
          </BlurFade>
        ))}
      </div>
    </SectionWrapper>
  )
}
