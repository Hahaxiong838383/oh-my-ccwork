'use client'

import Link from 'next/link'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { BlurFade } from '@/components/ui/BlurFade'
import { Glow } from '@/components/ui/Glow'

export function ContactCTA() {
  return (
    <SectionWrapper className="relative overflow-hidden">
      <Glow className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" size="500px" />
      <div className="relative z-10 text-center">
        <BlurFade>
          <h2 className="mb-4 text-3xl font-bold tracking-tight text-text-primary md:text-4xl">
            有想法？聊聊
          </h2>
        </BlurFade>
        <BlurFade delay={0.1}>
          <p className="mb-8 text-text-secondary">
            想聊产品合作或技术方案，可以通过邮箱或微信联系我。
          </p>
        </BlurFade>
        <BlurFade delay={0.2}>
          <Link
            href="/contact"
            className="inline-block rounded-lg bg-accent px-8 py-3 text-sm font-medium text-white transition-all duration-300 hover:bg-accent/90 hover:shadow-lg hover:shadow-accent/20"
          >
            取得联系
          </Link>
        </BlurFade>
      </div>
    </SectionWrapper>
  )
}
