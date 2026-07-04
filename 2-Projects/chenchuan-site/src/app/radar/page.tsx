import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { RadarPipeline } from '@/components/radar/RadarPipeline'
import { RadarFeed } from '@/components/radar/RadarFeed'
import { TheoryReportSection } from '@/components/radar/TheoryReportSection'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { getRadarFeed, getTheoryReports } from '@/lib/radar'

export const metadata: Metadata = {
  title: 'AI 前沿资讯雷达',
  description:
    '一条用 AI 搭的自动化情报产线：每 30 分钟自动聚合 AI 全域信源，去重归类后上站。附 arXiv 前沿论文的中文深度拆解。',
}

export default async function RadarPage() {
  // Opt out of the Full Route Cache so visitors never get a days-old ISR shell.
  // Upstream aihot fetches still use their own 15min Data Cache in src/lib/radar/aihot.ts.
  await headers()

  const [feed, reports] = await Promise.all([getRadarFeed(), getTheoryReports()])

  return (
    <>
      <RadarPipeline
        ok={feed.ok}
        count={feed.items.length}
        sourceCount={feed.sourceCount}
        fetchedAt={feed.fetchedAt}
      />

      <SectionWrapper>
        <SectionTitle label="Live Feed / 实时资讯" title="AI 全域热点" />
        <RadarFeed items={feed.items} />
      </SectionWrapper>

      <SectionWrapper id="deep-dive" className="scroll-mt-24 pt-0">
        <TheoryReportSection reports={reports} />
      </SectionWrapper>

      <RadarCTA />
    </>
  )
}

function RadarCTA() {
  return (
    <SectionWrapper className="pt-0">
      <BlurFade>
        <div className="overflow-hidden rounded-3xl border border-border bg-bg-secondary px-6 py-12 md:px-12 md:py-14">
          <div className="grid gap-8 md:grid-cols-2 md:items-center">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-text-primary md:text-3xl">
                想要一条这样的情报产线？
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-text-secondary">
                从信源抓取、自动聚合过滤，到每天自动出一份专业简报——这套自动化工作流，我能用
                AI 帮你的团队/机构快速跑通。也欢迎订阅这份雷达，第一时间收到。
              </p>
            </div>
            <div className="flex flex-col gap-3 md:items-end">
              <Link
                href="/contact"
                className="group inline-flex items-center justify-center gap-2 rounded-lg bg-text-primary px-6 py-3 text-sm font-semibold text-bg-primary transition-all duration-300 hover:opacity-90"
              >
                加微信 · 聊聊自动化合作
                <span className="font-mono transition group-hover:translate-x-1">→</span>
              </Link>
              <Link
                href="/contact"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-6 py-3 text-sm font-medium text-text-secondary transition-colors hover:border-border-hover hover:text-text-primary"
              >
                订阅每日雷达
              </Link>
            </div>
          </div>
        </div>
      </BlurFade>
    </SectionWrapper>
  )
}
