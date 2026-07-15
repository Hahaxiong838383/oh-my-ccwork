'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LogoutButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  const handleLogout = async (): Promise<void> => {
    setLoading(true)
    try {
      await fetch('/api/admin/logout', { method: 'POST' })
    } catch {
      // 静默
    } finally {
      router.push('/admin/login')
      router.refresh()
    }
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      disabled={loading}
      className="inline-flex min-h-10 touch-manipulation items-center justify-center whitespace-nowrap rounded border border-white/15 bg-white/[0.04] px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-white/70 transition hover:border-white/35 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
    >
      {loading ? '退出中...' : '退出登录'}
    </button>
  )
}
