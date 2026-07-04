import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import { getStats } from '@/lib/analytics/stats'
import { formatGeo, lookupGeoBatch, type GeoInfo } from '@/lib/analytics/geo'
import { LogoutButton } from '@/components/admin/LogoutButton'
import { TrendChart } from '@/components/admin/TrendChart'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function formatTime(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

export default async function AdminDashboard() {
  // 鉴权：未登录跳 /admin/login（双保险，middleware 已经会拦）
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  const claims = token ? await verifySession(token) : null
  if (!claims) {
    redirect('/admin/login')
  }

  // 直接 server-side 查 SQLite（同步 API，<10ms）
  let statsError: string | null = null
  let stats: Awaited<ReturnType<typeof getStats>> | null = null
  try {
    stats = getStats()
  } catch (err) {
    statsError = err instanceof Error ? err.message : '加载失败'
  }

  // recent 50 条 IP 批量查归属地（外网 + 进程缓存）。失败兜底成空 Map，不影响渲染。
  let geoMap = new Map<string, GeoInfo>()
  if (stats && stats.recent.length > 0) {
    const ips = stats.recent.map((r) => r.ip).filter((x): x is string => Boolean(x))
    try {
      geoMap = await lookupGeoBatch(ips)
    } catch {
      // ignore，已 fallback 到空 map
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.3em] text-sky-200/85">
            Admin · Analytics
          </div>
          <h1 className="text-2xl font-bold text-white">访问统计后台</h1>
          <p className="mt-1 text-xs text-white/50">
            已登录：{claims.username} · 数据保留 90 天 · IP + 归属地仅管理员可见
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/admin/chat-demos"
            className="rounded border border-[#7FE5FF]/40 bg-[#7FE5FF]/[0.06] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.16em] text-[#7FE5FF] transition hover:bg-[#7FE5FF]/[0.12]"
          >
            Chat Demos →
          </a>
          <a
            href="/admin/videos"
            className="rounded border border-[#7FE5FF]/40 bg-[#7FE5FF]/[0.06] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.16em] text-[#7FE5FF] transition hover:bg-[#7FE5FF]/[0.12]"
          >
            视频管理 →
          </a>
          <LogoutButton />
        </div>
      </header>

      {statsError && (
        <div className="mb-6 rounded border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          统计数据加载失败：{statsError}
        </div>
      )}

      {stats && (
        <>
          {/* 总览卡片 */}
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="今日 PV · 浏览量" value={stats.today.pv} accent="#7dd3fc" />
            <StatCard label="今日 UV · 访客数" value={stats.today.uv} accent="#a78bfa" />
            <StatCard label="7 天 PV · 浏览量" value={stats.week.pv} accent="#7dd3fc" />
            <StatCard label="7 天 UV · 访客数" value={stats.week.uv} accent="#a78bfa" />
          </div>

          {/* 趋势图 */}
          <section className="mb-6 rounded-lg border border-white/10 bg-white/[0.02] p-5">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">
                7 天访问趋势
              </h2>
              <span className="text-[11px] text-white/45">
                <span className="text-[#7dd3fc]">PV</span> = 页面浏览量（每次打开都算） ·{' '}
                <span className="text-[#a78bfa]">UV</span> = 独立访客数（按 IP+UA 去重）
              </span>
            </div>
            <TrendChart data={stats.trend} />
          </section>

          {/* 三个 Top 表格并排 */}
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <TopList title="Top 10 页面" rows={stats.topPaths.map((r) => ({ key: r.path, count: r.count }))} />
            <TopList title="Top 10 来源" rows={stats.topReferrers.map((r) => ({ key: r.referrer, count: r.count }))} />
            <TopList title="Top 10 国家" rows={stats.topCountries.map((r) => ({ key: r.country, count: r.count }))} />
          </div>

          {/* 最近访问 */}
          <section className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">
                最近 50 条访问
              </h2>
              <span className="text-[11px] text-white/45">
                IP 归属地 / ISP 数据来自 ip-api.com（24h 缓存，外网失败时空）
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-white/45">
                    <th className="pb-2 pr-4 font-mono">时间</th>
                    <th className="pb-2 pr-4 font-mono">路径</th>
                    <th className="pb-2 pr-4 font-mono">IP</th>
                    <th className="pb-2 pr-4 font-mono">归属地 · ISP</th>
                    <th className="pb-2 pr-4 font-mono">来源</th>
                    <th className="pb-2 font-mono">国家</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent.map((r, i) => {
                    const ip = r.ip ?? null
                    const geo = ip ? geoMap.get(ip) : undefined
                    const geoText = formatGeo(geo, r.country)
                    return (
                      <tr key={i} className="border-b border-white/[0.04] text-white/80">
                        <td className="py-2 pr-4 font-mono text-[11px] text-white/60">{formatTime(r.ts)}</td>
                        <td className="py-2 pr-4 font-mono">{r.path}</td>
                        <td className="py-2 pr-4 font-mono text-[11px] text-white/75" title={ip ?? '未知'}>
                          {ip ?? '—'}
                        </td>
                        <td
                          className="max-w-[280px] truncate py-2 pr-4 text-white/70"
                          title={geoText}
                        >
                          {geoText}
                        </td>
                        <td className="max-w-[200px] truncate py-2 pr-4 text-white/55">
                          {r.referrer ?? '(直接访问)'}
                        </td>
                        <td className="py-2 font-mono text-white/70">{r.country ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {stats.recent.length === 0 && (
                <p className="py-4 text-center text-sm text-white/40">暂无访问数据</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

interface StatCardProps {
  label: string
  value: number
  accent: string
}

function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <div
      className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
      style={{ borderTop: `2px solid ${accent}` }}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/50">
        {label}
      </div>
      <div className="mt-1 font-mono text-3xl text-white">{value.toLocaleString()}</div>
    </div>
  )
}

interface TopListProps {
  title: string
  rows: Array<{ key: string; count: number }>
}

function TopList({ title, rows }: TopListProps) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-white/60">{title}</h2>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-white/40">暂无数据</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={i}>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-white/85" title={r.key}>
                  {r.key}
                </span>
                <span className="shrink-0 font-mono text-white/55">{r.count}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded bg-white/[0.05]">
                <div
                  className="h-full bg-sky-300/70"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
