import { BlurFade } from '@/components/ui/BlurFade'
import type { GithubRadarReport } from '@/lib/radar/types'

const VIOLET = '#6D5BD0'

function fmtStars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// GitHub 风向标：github-radar agent 每日抓取近 7 天 AI 热点开源项目（自有源，2026-07-07 上站）
// 纯静态渲染（server component）：分类分组 + star + 一句话描述；judgments 为 cc 自进化判断（可选）
export function GithubRadarSection({ report }: { report: GithubRadarReport }) {
  return (
    <div className="rounded-3xl border border-[#6D5BD0]/20 bg-[#6D5BD0]/[0.04] p-6 md:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div
            className="font-mono text-[11px] uppercase tracking-[0.18em]"
            style={{ color: VIOLET }}
          >
            开源风向标 · GitHub 雷达
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-text-primary md:text-2xl">
            AI 开源项目热点
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            近 7 天活跃的 AI Agent / 多智能体 / 记忆系统 / 工具框架开源项目，每日自动扫描。
          </p>
        </div>
        <div className="font-mono text-xs text-text-secondary">{report.date} 期</div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {report.categories.map((cat, ci) => (
          <BlurFade key={cat.label} delay={ci * 0.05}>
            <div className="h-full rounded-2xl border border-border bg-bg-primary/60 p-5">
              <div className="mb-3 text-sm font-semibold text-text-primary">{cat.label}</div>
              <ul className="space-y-3">
                {cat.repos.map((repo) => (
                  <li key={repo.name} className="flex items-baseline gap-3">
                    <span
                      className="w-14 shrink-0 text-right font-mono text-xs tabular-nums"
                      style={{ color: VIOLET }}
                    >
                      ★{fmtStars(repo.stars)}
                    </span>
                    <div className="min-w-0">
                      <a
                        href={repo.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-sm font-medium text-text-primary underline-offset-4 hover:underline"
                      >
                        {repo.name}
                      </a>
                      {repo.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                          {repo.description}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </BlurFade>
        ))}
      </div>

      {report.judgments && report.judgments.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-[#6D5BD0]/25 bg-[#6D5BD0]/[0.06] p-5">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em]" style={{ color: VIOLET }}>
            cc 的判断 · 值得跟进
          </div>
          <ul className="space-y-1.5">
            {report.judgments.map((j) => (
              <li key={j.repo} className="text-sm text-text-secondary">
                <span className="font-medium text-text-primary">{j.repo}</span>
                <span className="mx-1.5">—</span>
                {j.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
