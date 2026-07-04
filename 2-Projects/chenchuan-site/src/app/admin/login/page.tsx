'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminLoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        if (res.status === 429) {
          setError('登录尝试过于频繁，请 1 分钟后再试')
        } else if (res.status === 401) {
          setError('账号或密码错误')
        } else {
          setError('登录失败，请重试')
        }
        return
      }
      router.push('/admin')
      router.refresh()
    } catch {
      setError('网络错误，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#03060b] px-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border border-white/10 bg-white/[0.04] p-8 backdrop-blur-md"
      >
        <h1 className="mb-1 font-mono text-xs uppercase tracking-[0.3em] text-sky-200/85">
          Admin · Analytics
        </h1>
        <p className="mb-7 text-2xl font-bold text-white">访问统计后台</p>

        <label className="mb-4 block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-white/55">
            账号
          </span>
          <input
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-sky-300/60"
          />
        </label>

        <label className="mb-5 block">
          <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-wider text-white/55">
            密码
          </span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-sky-300/60"
          />
        </label>

        {error && (
          <div className="mb-4 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password}
          className="w-full rounded bg-sky-300 px-4 py-2.5 text-sm font-semibold text-[#03060b] transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? '登录中...' : '登录'}
        </button>
      </form>
    </div>
  )
}
