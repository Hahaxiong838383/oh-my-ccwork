'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

interface BlurFadeProps {
  children: React.ReactNode
  className?: string
  delay?: number
}

export function BlurFade({
  children,
  className,
  delay = 0,
}: BlurFadeProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // 元素挂载时若已在视口内，直接显示（IntersectionObserver 首次回调有时
    // 在 HMR / SSR 衔接边缘情况下会以 isIntersecting:false 触发，导致永远不亮）
    const rect = el.getBoundingClientRect()
    const inViewport =
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    if (inViewport) {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.1 },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={cn(
        'transition-all duration-700 ease-out',
        visible
          ? 'translate-y-0 rotate-0 opacity-100 blur-0'
          : 'translate-y-5 rotate-[0.6deg] opacity-0 blur-[3px]',
        className,
      )}
      style={{ transitionDelay: `${delay * 1000}ms` }}
    >
      {children}
    </div>
  )
}
