import { cookies } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import type { TrafficKind } from '@/lib/analytics/classify'
import { getSystemTrafficStats } from '@/lib/analytics/stats'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type SystemKind = Exclude<TrafficKind, 'human'>

const KIND_META: Record<SystemKind, { label: string; description: string; color: string }> = {
  owner: {
    label: '站长调试',
    description: '后台登录浏览器、站长出口与命令行验收',
    color: '#fbbf24',
  },
  aiops: {
    label: 'AI Ops / 监控',
    description: 'AI Ops、Kuma、健康检查与维护节点',
    color: '#34d399',
  },
  prefetch: {
    label: '浏览器预加载',
    description: 'Next.js 与浏览器提前请求但未真正浏览的页面',
    color: '#60a5fa',
  },
  bot: {
    label: '机器人 / 扫描',
    description: '爬虫、无头浏览器、漏洞扫描与非浏览器客户端',
    color: '#fb7185',
  },
  legacy: {
    label: '历史未验证',
    description: '旧版记录缺少浏览器 hydration 证据，不计入真实访客',
    color: '#a1a1aa',
  },
}

const REASON_LABELS: Record<string, string> = {
  owner_admin_session: '有效后台登录',
  owner_ip: '站长出口 IP',
  aiops_user_agent: 'AI Ops / Kuma 标识',
  aiops_ip: '维护节点 IP',
  next_router_prefetch: 'Next.js 路由预加载',
  middleware_prefetch: 'Middleware 预加载',
  browser_prefetch: '浏览器预加载',
  legacy_prefetch_burst: '历史同秒多页面预加载',
  unverified_legacy_browser: '旧版浏览器记录，无法证明真人',
  invalid_page_path: '非站点页面路径',
  empty_user_agent: '无 User-Agent',
  known_bot_user_agent: '已知机器人客户端',
  non_browser_client: '非浏览器客户端',
  unknown: '未标注',
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts))
}

export default async function SystemTrafficPage() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  const claims = token ? await verifySession(token) : null
  if (!claims) redirect('/admin/login')

  let error: string | null = null
  let stats: ReturnType<typeof getSystemTrafficStats> | null = null
  try {
    stats = getSystemTrafficStats()
  } catch (err) {
    error = err instanceof Error ? err.message : '加载失败'
  }

  const buckets = new Map(stats?.buckets.map((bucket) => [bucket.kind, bucket]) ?? [])
  const visibleKinds: SystemKind[] = ['owner', 'aiops', 'prefetch', 'bot']
  if (buckets.has('legacy')) visibleKinds.push('legacy')

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.3em] text-amber-200/85">
            Admin · System Traffic
          </div>
          <h1 className="text-2xl font-bold text-white">系统与维护流量</h1>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-white/50">
            这里单独保留站长调试、AI Ops、监控、预加载和机器人访问。所有数据均不计入真实访客 PV / UV。
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded border border-sky-300/40 bg-sky-300/[0.06] px-3 py-1.5 text-[11px] font-mono uppercase tracking-[0.16em] text-sky-200 transition hover:bg-sky-300/[0.12]"
        >
          ← 真实访客统计
        </Link>
      </header>

      {error && (
        <div className="mb-6 rounded border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
          系统流量加载失败：{error}
        </div>
      )}

      {stats && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {visibleKinds.map((kind) => {
              const meta = KIND_META[kind]
              const bucket = buckets.get(kind)
              return (
                <section
                  key={kind}
                  className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
                  style={{ borderTop: `2px solid ${meta.color}` }}
                >
                  <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/70">
                    {meta.label}
                  </div>
                  <div className="mt-2 font-mono text-3xl text-white">
                    {(bucket?.week ?? 0).toLocaleString()}
                  </div>
                  <div className="mt-1 text-[11px] text-white/45">
                    近 7 天 · 今日 {(bucket?.today ?? 0).toLocaleString()} · 90 天 {(bucket?.total ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-3 text-xs leading-5 text-white/50">{meta.description}</p>
                </section>
              )
            })}
          </div>

          <section className="mb-6 rounded-lg border border-white/10 bg-white/[0.02] p-5">
            <h2 className="mb-4 font-mono text-xs uppercase tracking-[0.18em] text-white/60">
              近 7 天分类原因
            </h2>
            {stats.topReasons.length === 0 ? (
              <p className="py-4 text-center text-sm text-white/40">暂无系统流量</p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {stats.topReasons.map((row) => (
                  <div
                    key={`${row.kind}:${row.reason}`}
                    className="flex items-center justify-between gap-3 rounded border border-white/[0.07] bg-black/10 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span
                        className="mr-2 font-mono text-[10px] uppercase"
                        style={{ color: KIND_META[row.kind].color }}
                      >
                        {KIND_META[row.kind].label}
                      </span>
                      <span className="text-xs text-white/70">
                        {REASON_LABELS[row.reason] ?? row.reason}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-sm text-white/80">
                      {row.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-white/60">
                最近 100 条系统流量
              </h2>
              <span className="text-[11px] text-white/40">仅管理员可见，便于排障和维护审计</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-left text-[12px]">
                <thead>
                  <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-white/45">
                    <th className="pb-2 pr-4 font-mono">时间</th>
                    <th className="pb-2 pr-4 font-mono">类别</th>
                    <th className="pb-2 pr-4 font-mono">原因</th>
                    <th className="pb-2 pr-4 font-mono">路径</th>
                    <th className="pb-2 pr-4 font-mono">IP</th>
                    <th className="pb-2 font-mono">客户端</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.recent.map((row, index) => {
                    const meta = KIND_META[row.trafficKind]
                    return (
                      <tr key={`${row.ts}:${index}`} className="border-b border-white/[0.04] text-white/75">
                        <td className="whitespace-nowrap py-2 pr-4 font-mono text-[11px] text-white/55">
                          {formatTime(row.ts)}
                        </td>
                        <td className="py-2 pr-4 font-mono text-[11px]" style={{ color: meta.color }}>
                          {meta.label}
                        </td>
                        <td className="py-2 pr-4 text-white/60">
                          {REASON_LABELS[row.trafficReason ?? 'unknown'] ?? row.trafficReason ?? '—'}
                        </td>
                        <td className="max-w-[240px] truncate py-2 pr-4 font-mono" title={row.path}>
                          {row.path}
                        </td>
                        <td className="whitespace-nowrap py-2 pr-4 font-mono text-[11px] text-white/60">
                          {row.ip ?? '—'}
                        </td>
                        <td className="max-w-[360px] truncate py-2 text-[11px] text-white/45" title={row.ua ?? '无 UA'}>
                          {row.ua ?? '无 UA'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {stats.recent.length === 0 && (
                <p className="py-4 text-center text-sm text-white/40">暂无系统流量</p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
