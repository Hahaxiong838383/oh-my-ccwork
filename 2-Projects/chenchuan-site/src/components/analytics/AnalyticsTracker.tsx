'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

const DEDUPE_WINDOW_MS = 1500

export function AnalyticsTracker() {
  const pathname = usePathname()
  const previousPath = useRef<string | null>(null)

  useEffect(() => {
    if (!pathname || pathname.startsWith('/admin')) return

    const storageKey = `cc_analytics:${pathname}`
    const now = Date.now()
    try {
      const lastSentAt = Number(sessionStorage.getItem(storageKey) ?? 0)
      if (now - lastSentAt < DEDUPE_WINDOW_MS) return
      sessionStorage.setItem(storageKey, String(now))
    } catch {
      // Safari 隐私模式等场景下 sessionStorage 可能不可用，仍继续上报。
    }

    const referrer = previousPath.current ?? document.referrer ?? null
    previousPath.current = pathname

    void fetch('/api/track', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'client',
        path: pathname,
        referrer,
      }),
    }).catch(() => {
      // 统计失败不能影响页面体验。
    })
  }, [pathname])

  return null
}
