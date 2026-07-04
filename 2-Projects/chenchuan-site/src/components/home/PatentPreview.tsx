'use client'

import Link from 'next/link'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { NumberTicker } from '@/components/ui/NumberTicker'
import type { Patent } from '@/data/patents'

interface Props {
  patents: Patent[]
}

export function PatentPreview({ patents }: Props) {
  return (
    <SectionWrapper className="border-t border-border">
      <div className="grid gap-12 md:grid-cols-[1fr_2fr]">
        <BlurFade>
          <div>
            <SectionTitle label="专利创新" title="46 项原创" className="mb-6" />
            <div className="mb-4 text-5xl font-bold text-text-primary">
              <NumberTicker value={patents.length} />
              <span className="ml-1 text-xl text-text-secondary">项专利</span>
            </div>
            <p className="text-sm text-text-secondary">
              覆盖 AR HUD、空间显示、机器人导航、无人零售与智能设备控制
            </p>
            <Link
              href="/patents"
              className="mt-4 inline-block text-sm text-accent transition-colors hover:text-accent/80"
            >
              查看全部 &rarr;
            </Link>
          </div>
        </BlurFade>

        <BlurFade delay={0.15}>
          <div className="rounded-xl border border-border bg-bg-card overflow-hidden">
            <div className="divide-y divide-white/[0.04]">
              {patents.slice(0, 6).map((patent) => (
                <div key={patent.number} className="flex items-start gap-3 px-5 py-3">
                  <span
                    className={`mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[10px] ${
                      patent.status === '发明授权'
                        ? 'bg-emerald-600/10 text-emerald-600'
                        : patent.status === '发明'
                          ? 'bg-accent/10 text-accent'
                          : 'bg-orange-500/10 text-orange-300 ring-1 ring-orange-400/20'
                    }`}
                  >
                    {patent.statusLabel}
                  </span>
                  <span className="font-mono text-xs leading-relaxed text-text-secondary">
                    {patent.title}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </BlurFade>
      </div>
    </SectionWrapper>
  )
}
