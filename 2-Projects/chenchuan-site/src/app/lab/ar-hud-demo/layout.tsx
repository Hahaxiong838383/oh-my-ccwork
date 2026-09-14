import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'AR HUD Demo · 多模态交互沙盒',
  description: '陈川 · AR HUD 多模态交互演示。尝试眼动、手势和表情检测，摄像头画面在浏览器内处理，不上传视频。',
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
