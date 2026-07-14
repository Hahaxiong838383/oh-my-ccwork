import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { VoiceExperienceManager } from '@/components/admin/VoiceExperienceManager'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function VoiceExperienceAdminPage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value
  if (!token || !(await verifySession(token))) redirect('/admin/login')
  return (
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <div className="mx-auto max-w-6xl">
        <Link href="/admin" className="text-xs text-white/45 hover:text-white">← 返回管理后台</Link>
        <div className="mb-8 mt-5">
          <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#B8ADFF]">Admin · Voice Experience</div>
          <h1 className="mt-2 text-3xl font-bold">公开语音体验管理</h1>
          <p className="mt-2 text-sm text-white/50">生成追加体验码、重置访客基础额度。不会展示或保存访客对话内容。</p>
        </div>
        <VoiceExperienceManager />
      </div>
    </main>
  )
}
