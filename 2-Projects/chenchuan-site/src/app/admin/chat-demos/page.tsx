import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import { listClassicDemos } from '@/lib/chat/demos'
import { ChatDemoManager } from '@/components/admin/ChatDemoManager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function ChatDemosAdminPage() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  const claims = token ? await verifySession(token) : null
  if (!claims) {
    redirect('/admin/login')
  }

  let demos = listClassicDemos(200)
  let loadError: string | null = null
  if (!demos) {
    loadError = '加载 demo 列表失败'
    demos = []
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.3em] text-sky-200/85">
            Admin · Classic Demos
          </div>
          <h1 className="text-2xl font-bold text-white">经典提问回放数据管理</h1>
          <p className="mt-1 text-xs text-white/50">
            已登录：{claims.username} · 数据存 analytics.db classic_demos 表 ·
            前端 /ai-os/chat 自动加载 featured demo
          </p>
        </div>
        <a
          href="/admin"
          className="rounded border border-white/15 bg-black/40 px-3 py-1.5 text-[11px] text-white/70 transition hover:border-[#7FE5FF]/40 hover:text-[#7FE5FF]"
        >
          ← 返回访问统计
        </a>
      </header>

      {loadError && (
        <div className="mb-6 rounded border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          {loadError}
        </div>
      )}

      <ChatDemoManager initialDemos={demos ?? []} />
    </div>
  )
}
