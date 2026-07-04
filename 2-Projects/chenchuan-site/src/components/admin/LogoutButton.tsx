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
      className="rounded border border-white/15 bg-white/[0.04] px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-white/70 transition hover:border-white/35 hover:text-white disabled:opacity-50"
    >
      {loading ? '退出中...' : '退出登录'}
    </button>
  )
}
