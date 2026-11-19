'use client'

import { useEffect, useState } from 'react'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { BlurFade } from '@/components/ui/BlurFade'
import { NumberTicker } from '@/components/ui/NumberTicker'
import { getCareerExperience } from '@/lib/experience'

export function Stats({ patentCount }: { patentCount: number }) {
  const [careerExperience, setCareerExperience] = useState(() => getCareerExperience())
  const stats = [
    {
      value: careerExperience.years,
      suffix: `年${careerExperience.months}个月${careerExperience.days}天`,
      label: '产品经验',
    },
    { value: patentCount, suffix: '', label: '项专利成果' },
    { text: '软硬件', label: '产品研发与量产经验' },
    { text: '跨职能', label: '产品与团队协作' },
  ]

  useEffect(() => {
    const update = () => setCareerExperience(getCareerExperience())
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <SectionWrapper id="stats" className="border-y border-border">
      <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
        {stats.map((stat, i) => (
          <BlurFade key={stat.label} delay={i * 0.1}>
            <div className="text-center">
              <div className="mb-1 text-3xl font-bold text-text-primary md:text-4xl">
                {'text' in stat ? stat.text : <NumberTicker value={stat.value!} suffix={stat.suffix} />}
              </div>
              <div className="font-mono text-xs text-text-secondary">{stat.label}</div>
            </div>
          </BlurFade>
        ))}
      </div>
    </SectionWrapper>
  )
}
