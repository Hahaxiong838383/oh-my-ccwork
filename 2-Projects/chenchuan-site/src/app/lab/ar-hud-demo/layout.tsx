import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'AR HUD Demo · 多模态交互沙盒',
  description: '陈川 · AR HUD 多模态交互演示。眼动、手势、表情同步检测，100% 本地推理，零数据上传。',
}

export default function ArHudDemoLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <>
      <style>{`
        body { overflow: hidden; }
        .site-header, .site-footer, .site-scroll-progress, .site-ambient-field { display: none !important; }
      `}</style>
      <section className="min-h-screen bg-black text-white">{children}</section>
    </>
  )
}
