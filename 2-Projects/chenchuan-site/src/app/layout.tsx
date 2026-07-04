import type { Metadata } from 'next'
import { inter } from '@/lib/fonts'
import { Header } from '@/components/layout/Header'
import { Footer } from '@/components/layout/Footer'
import { SiteMotion } from '@/components/layout/SiteMotion'
import '@/styles/globals.css'

export const metadata: Metadata = {
  title: {
    default: '陈川 · AI 原生产品负责人',
    template: '%s · 陈川',
  },
  description:
    'AI 原生产品负责人，19 年 10 个月智能硬件与 AI 产品经验。主导空间光学、AR HUD、多模态交互、Agent 工作流与 AI 消费品孵化。',
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
    title: '陈川 · AI 原生产品负责人',
    description:
      'AI 原生产品负责人，19 年 10 个月智能硬件与 AI 产品经验，46 项专利成果。',
    type: 'website',
    locale: 'zh_CN',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN">
      <body className={`${inter.variable} font-sans`}>
        <SiteMotion />
        <Header />
        <main className="relative z-10 min-h-screen">{children}</main>
        <Footer />
      </body>
    </html>
  )
}
