import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import { listManagedVideos } from '@/lib/videos/store'
import { projects } from '@/data/projects'
import { VideoManager } from '@/components/admin/VideoManager'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function VideosAdminPage() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  const claims = token ? await verifySession(token) : null
  if (!claims) {
    redirect('/admin/login')
  }

  let videos = listManagedVideos(500)
  let loadError: string | null = null
  if (!videos) {
    loadError = '加载视频列表失败'
    videos = []
  }

  const projectOptions = projects.map((p) => ({ slug: p.slug, title: p.title }))

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.3em] text-sky-200/85">
            Admin · Videos
          </div>
          <h1 className="text-2xl font-bold text-white">视频库管理</h1>
          <p className="mt-1 text-xs text-white/50">
            已登录：{claims.username} · 数据存 analytics.db videos 表 ·
            含已下架视频（admin 看全部）
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

      <VideoManager initialVideos={videos ?? []} projects={projectOptions} />
    </div>
  )
}
