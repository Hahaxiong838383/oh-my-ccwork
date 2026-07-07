'use client'

import { useEffect, useState } from 'react'

export interface RadarNavSection {
  id: string
  label: string
  color: string
}

// 雷达页板块快速跳转（sticky 锚点条 + scroll-spy 高亮 + 回顶按钮）
// 设计取舍：保持一页总览心智（非互斥 tab），点击平滑滚动到锚点；锚点 URL（#deep-dive）可直达可分享。
export function RadarSectionNav({ sections }: { sections: RadarNavSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? '')
  const [showTop, setShowTop] = useState(false)

  useEffect(() => {
    // scroll-spy：确定性计算——取「顶部判定线(160px)以上最近」的板块高亮。
    // 不用 IntersectionObserver：板块都很长，多区同时相交时回调顺序不定，高亮会漂。
    let ticking = false
    const compute = () => {
      ticking = false
      setShowTop(window.scrollY > 900)
      let current = sections[0]?.id ?? ''
      for (const s of sections) {
        const el = document.getElementById(s.id)
        if (el && el.getBoundingClientRect().top <= 160) current = s.id
      }
      setActive(current)
    }
    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(compute)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    compute()
    return () => window.removeEventListener('scroll', onScroll)
  }, [sections])

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActive(id)
    if (typeof history !== 'undefined') history.replaceState(null, '', `#${id}`)
  }

  return (
    <>
      <div className="sticky top-[64px] z-40 -mx-2 px-2">
        <div className="mx-auto max-w-content px-6 md:px-8">
          <div className="flex gap-2 overflow-x-auto rounded-full border border-border bg-bg-primary/85 p-1.5 backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:inline-flex">
            {sections.map((s) => {
              const isActive = active === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => jump(s.id)}
                  className={
                    'whitespace-nowrap rounded-full px-4 py-1.5 text-sm transition-all duration-200 ' +
                    (isActive
                      ? 'font-semibold text-bg-primary'
                      : 'text-text-secondary hover:text-text-primary')
                  }
                  style={isActive ? { backgroundColor: s.color } : undefined}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* 深滚后浮出的回顶按钮 */}
      <button
        type="button"
        aria-label="回到顶部"
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className={
          'fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-bg-primary/90 text-text-secondary shadow-lg backdrop-blur transition-all duration-300 hover:text-text-primary ' +
          (showTop ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0')
        }
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </>
  )
}
