import type { Metadata } from 'next'
import { inter } from '@/lib/fonts'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { SiteMotion } from '@/components/layout/SiteMotion'
import { AnalyticsTracker } from '@/components/analytics/AnalyticsTracker'
import { formatCareerExperience } from '@/lib/experience'
import { patents } from '@/data/patents'
import '@/styles/globals.css'

export function generateMetadata(): Metadata {
  const experience = formatCareerExperience(undefined, { spaced: true, includeDays: true })

  return {
    title: {
      default: '陈川 · AI Native 产品经理',
      template: '%s · 陈川',
    },
    description:
      `AI Native 产品经理，${experience}产品经验。做儿童 AI 伙伴、团队 AI 助手和 AR HUD，参与产品定义、技术选型、原型开发与验收。`,
    keywords: [
      '陈川',
      'Chen Chuan',
      'AI Product',
      'AR HUD',
      'Embodied Intelligence',
      'Spatial Computing',
      'Vibe Coding',
      'Agent OS',
      'AI Memory',
      'Spatial Optics',
    ],
    openGraph: {
      title: '陈川 · AI Native 产品经理',
      description:
        `AI Native 产品经理，${experience}产品经验，${patents.length} 项专利记录。儿童 AI、团队 AI 助手与 AR HUD 项目。`,
      type: 'website',
      locale: 'zh_CN',
    },
  }
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body className={`${inter.variable} font-sans`}>
        <AnalyticsTracker />
        <SiteMotion />
        <Header />
        <main className="relative z-10 min-h-screen">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
