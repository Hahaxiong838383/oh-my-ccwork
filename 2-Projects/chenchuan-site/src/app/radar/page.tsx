import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { RadarPipeline } from '@/components/radar/RadarPipeline'
import { RadarSectionNav } from '@/components/radar/RadarSectionNav'
import { RadarFeed } from '@/components/radar/RadarFeed'
import { HorizonDigestSection } from '@/components/radar/HorizonDigestSection'
import { TheoryReportSection } from '@/components/radar/TheoryReportSection'
import { GithubRadarSection } from '@/components/radar/GithubRadarSection'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import {
  getHorizonDigestReports,
  getLatestGithubRadar,
  getRadarFeed,
  getTheoryReports,
} from '@/lib/radar'

export const metadata: Metadata = {
  title: 'AI 前沿资讯雷达',
  description:
    '汇总 AI 行业资讯、开源项目和前沿论文，保留来源、日期与中文解读。',
}

export default async function RadarPage() {
  // Opt out of the Full Route Cache so visitors never get a days-old ISR shell.
  // Upstream aihot fetches still use their own 15min Data Cache in src/lib/radar/aihot.ts.
  await headers()

  const [feed, reports, githubReport, horizonReports] = await Promise.all([
    getRadarFeed(),
    getTheoryReports(),
    getLatestGithubRadar(),
    getHorizonDigestReports(),
  ])

  return (
    <>
      <RadarPipeline
        ok={feed.ok}
        count={feed.items.length}
        sourceCount={feed.sourceCount}
        fetchedAt={feed.fetchedAt}
      />

      <RadarSectionNav
        sections={[
          ...(horizonReports.length > 0
            ? [{ id: 'daily-picks', label: '今日精选', color: '#C15F22' }]
            : []),
          { id: 'feed', label: '实时资讯', color: '#0071E3' },
          { id: 'deep-dive', label: '深度拆解', color: '#16A34A' },
          ...(githubReport ? [{ id: 'github-radar', label: '开源风向标', color: '#6D5BD0' }] : []),
        ]}
      />

      {horizonReports.length > 0 ? (
        <SectionWrapper id="daily-picks" className="scroll-mt-28">
          <HorizonDigestSection reports={horizonReports} />
        </SectionWrapper>
      ) : null}

      <SectionWrapper
        id="feed"
        className={`scroll-mt-28 ${horizonReports.length > 0 ? 'pt-0' : ''}`}
      >
        <SectionTitle label="资讯汇总" title="AI 行业动态" />
        <RadarFeed items={feed.items} />
      </SectionWrapper>

      <SectionWrapper id="deep-dive" className="scroll-mt-28 pt-0">
        <TheoryReportSection reports={reports} />
      </SectionWrapper>

      {githubReport ? (
        <SectionWrapper id="github-radar" className="scroll-mt-28 pt-0">
          <GithubRadarSection report={githubReport} />
        </SectionWrapper>
      ) : null}

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
                也想整理团队关注的资讯？
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-text-secondary">
                可以聊聊你的团队关注什么、需要哪些信源，以及筛选规则和简报怎么安排。
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
                联系了解订阅
              </Link>
            </div>
          </div>
        </div>
      </BlurFade>
    </SectionWrapper>
  )
}
