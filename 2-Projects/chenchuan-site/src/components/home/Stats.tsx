'use client'

import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { BlurFade } from '@/components/ui/BlurFade'
import { NumberTicker } from '@/components/ui/NumberTicker'

const stats = [
  { value: 19, suffix: '年10个月', label: '产品经验' },
  { value: 46, suffix: '', label: '项专利成果' },
  { value: 9, suffix: '', label: '款量产/运营产品' },
  { value: 10, suffix: '+', label: '人产品市场团队' },
]

export function Stats() {
  return (
    <SectionWrapper id="stats" className="border-y border-border">
      <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
        {stats.map((stat, i) => (
          <BlurFade key={stat.label} delay={i * 0.1}>
            <div className="text-center">
              <div className="mb-1 text-3xl font-bold text-text-primary md:text-4xl">
                <NumberTicker value={stat.value} suffix={stat.suffix} />
              </div>
              <div className="font-mono text-xs text-text-secondary">{stat.label}</div>
            </div>
          </BlurFade>
        ))}
      </div>
    </SectionWrapper>
  )
}
