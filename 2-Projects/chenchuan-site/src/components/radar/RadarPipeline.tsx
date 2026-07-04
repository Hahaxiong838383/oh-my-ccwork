import { BlurFade } from '@/components/ui/BlurFade'
import { formatBJTime } from '@/lib/radar/types'

interface Props {
  ok: boolean
  count: number
  sourceCount: number
  fetchedAt: string
}

const STAGES: Array<{ no: string; name: string; detail: string }> = [
  { no: '01', name: '信源采集', detail: 'arXiv · 官方博客 · 行业站 · X/社区' },
  { no: '02', name: '自动聚合', detail: '多源并轨拉取 · 每 30 分钟' },
  { no: '03', name: '归类去重', detail: '5 大分类 · 去重 · 按时间排序' },
  { no: '04', name: '自动上站', detail: '你正在看的就是产线输出' },
]

export function RadarPipeline({ ok, count, sourceCount, fetchedAt }: Props) {
  const synced = formatBJTime(fetchedAt)
  return (
    <section className="relative overflow-hidden border-b border-border bg-bg-primary px-6 pb-14 pt-28 md:px-8 md:pb-16 lg:pt-32">
      <div className="mx-auto max-w-content">
        {/* meta 行：live 状态 + 上次同步 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-6 font-mono text-[11px] uppercase tracking-[0.18em] text-text-muted">
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 ${
              ok ? 'border-[#16A34A]/30 text-[#16A34A]' : 'border-[#B7791F]/30 text-[#B7791F]'
            }`}
          >
            <span
              className={`relative inline-block h-[6px] w-[6px] rounded-full ${
                ok ? 'animate-pulse bg-[#16A34A]' : 'bg-[#B7791F]'
              }`}
            />
            {ok ? '产线运行中' : '信源同步中'}
          </span>
          <span className="tabular-nums text-text-secondary">
            {synced ? `上次同步 UTC+8 ${synced}` : '同步中…'}
          </span>
        </div>

        {/* 标题 + 自动化叙事（白话） */}
        <div className="grid gap-10 py-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <div>
            <h1 className="text-[clamp(40px,6vw,72px)] font-semibold leading-[0.98] tracking-[-0.02em] text-text-primary">
              AI 前沿资讯雷达
            </h1>
            <BlurFade delay={0.15}>
              <p className="mt-6 max-w-xl text-lg font-light leading-relaxed text-text-secondary">
                一条我用 AI 搭的自动化情报产线：每 30 分钟自动把 AI
                全域信源聚到一起，去重、归类、排序后直接上站。
                <span className="text-text-primary">这一页本身，就是产线的实时输出</span>
                ——不是我手动整理的。
              </p>
            </BlurFade>
            <BlurFade delay={0.3}>
              <div className="mt-8 flex flex-wrap gap-x-10 gap-y-5 border-t border-border pt-6">
                <Stat value={ok ? String(count) : '—'} label="本轮条目" />
                <Stat value={ok ? String(sourceCount) : '—'} label="覆盖信源" />
                <Stat value="5" label="自动分类" />
                <Stat value="30min" label="刷新间隔" />
              </div>
            </BlurFade>
          </div>

          {/* 产线四节点可视化 */}
          <BlurFade delay={0.2}>
            <div className="flex h-full flex-col justify-center gap-2.5">
              {STAGES.map((s, i) => (
                <div key={s.no} className="relative">
                  <div className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 transition hover:border-border-hover">
                    <span className="mt-0.5 font-mono text-[11px] font-medium text-accent">
                      {s.no}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-text-primary">{s.name}</div>
                      <div className="mt-0.5 text-[12px] leading-snug text-text-muted">
                        {s.detail}
                      </div>
                    </div>
                  </div>
                  {i < STAGES.length - 1 && (
                    <div className="ml-[1.35rem] h-2.5 w-px bg-border" aria-hidden />
                  )}
                </div>
              ))}
            </div>
          </BlurFade>
        </div>
      </div>
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-[clamp(22px,2.6vw,30px)] font-medium leading-none tracking-[-0.02em] text-text-primary [font-variant-numeric:tabular-nums]">
        {value}
      </div>
      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
        {label}
      </div>
    </div>
  )
}
