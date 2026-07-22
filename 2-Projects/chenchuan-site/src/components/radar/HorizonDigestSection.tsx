'use client'

import { useMemo, useState } from 'react'
import { CATEGORY_META, formatBJTime } from '@/lib/radar/types'
import type { HorizonDigestItem, HorizonDigestReport } from '@/lib/radar/types'

const ORANGE = '#C15F22'
const QUICK_PICK_COUNT = 7

function dateLabel(date: string): string {
  return date.slice(5).replace('-', '.')
}

function scoreLabel(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

export function HorizonDigestSection({ reports }: { reports: HorizonDigestReport[] }) {
  const list = useMemo(() => reports.filter((report) => report.items.length > 0), [reports])
  const [selectedDate, setSelectedDate] = useState(list[0]?.date || '')
  const report = list.find((entry) => entry.date === selectedDate) || list[0]

  if (!report) return null
  const quickReports = list.slice(0, QUICK_PICK_COUNT)
  const olderReports = list.slice(QUICK_PICK_COUNT)

  return (
    <div className="overflow-hidden rounded-3xl border border-[#C15F22]/20 bg-[linear-gradient(145deg,rgba(193,95,34,0.08),rgba(255,255,255,0.68)_48%,rgba(193,95,34,0.03))] p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em]" style={{ color: ORANGE }}>
            每日 AI 精选 · 趋势解读
          </div>
          <h2 className="mt-2 max-w-2xl text-xl font-semibold tracking-tight text-text-primary md:text-2xl">
            今天真正值得关注的 AI 进展
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
            从国际技术社区、官方博客和开源动态中交叉筛选，补充实时资讯的广度，并提炼事件价值、技术细节与社区分歧。
          </p>
        </div>

        <div className="flex gap-5 font-mono text-[11px] text-text-muted">
          <Stat label="本期精选" value={`${report.items.length} 条`} />
          <Stat label="扫描范围" value={`${report.totalFetched} 条`} />
          <Stat label="信源" value={`${report.sourceCount} 个`} />
          {report.realtimeDuplicateCount ? (
            <Stat label="实时流去重" value={`${report.realtimeDuplicateCount} 条`} />
          ) : null}
        </div>
      </div>

      {list.length > 1 ? (
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[#C15F22]/10 pt-5">
          {quickReports.map((entry, index) => {
            const active = entry.date === report.date
            return (
              <button
                key={entry.date}
                type="button"
                onClick={() => setSelectedDate(entry.date)}
                className={`rounded-lg border px-3 py-1.5 font-mono text-[12px] transition-colors ${
                  active
                    ? 'border-[#C15F22] bg-[#C15F22] text-white'
                    : 'border-border bg-bg-card text-text-secondary hover:border-[#C15F22]/50 hover:text-text-primary'
                }`}
              >
                {dateLabel(entry.date)}{index === 0 ? ' · 最新' : ''}
              </button>
            )
          })}
          {olderReports.length > 0 ? (
            <select
              aria-label="选择更早的 AI 精选归档"
              value={olderReports.some((entry) => entry.date === report.date) ? report.date : ''}
              onChange={(event) => setSelectedDate(event.target.value)}
              className="rounded-lg border border-border bg-bg-card px-3 py-1.5 font-mono text-[12px] text-text-secondary outline-none transition hover:border-[#C15F22]/50 focus:border-[#C15F22]"
            >
              <option value="" disabled>更早归档</option>
              {olderReports.map((entry) => (
                <option key={entry.date} value={entry.date}>{entry.date}</option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#C15F22]/10 bg-bg-card/70 px-4 py-3.5">
        <p className="max-w-3xl text-sm leading-relaxed text-text-secondary">
          {report.summary || '本期精选已完成跨源去重、价值排序和背景补充。'}
        </p>
        <span className="shrink-0 font-mono text-[11px] text-text-muted">{report.date}</span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {report.items.map((item, index) => (
          <DigestCard key={`${report.date}-${item.id}-${index}`} item={item} index={index} />
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em]">{label}</div>
      <div className="mt-1 text-[13px] font-semibold text-text-primary">{value}</div>
    </div>
  )
}

function DigestCard({ item, index }: { item: HorizonDigestItem; index: number }) {
  const meta = item.category ? CATEGORY_META[item.category] : null
  const time = formatBJTime(item.publishedAt)
  const detailAvailable = Boolean(
    item.whyItMatters || item.keyDetails || item.background || item.communityDiscussion || item.references.length,
  )

  return (
    <article className="flex h-full flex-col rounded-2xl border border-border bg-bg-card p-5 shadow-[0_12px_40px_rgba(98,52,22,0.04)]">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-text-muted">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#C15F22]/10 font-semibold text-[#C15F22]">
            {String(index + 1).padStart(2, '0')}
          </span>
          <span className="truncate">{item.source}</span>
          {time ? <span className="shrink-0">· {time}</span> : null}
        </div>
        <span className="shrink-0 rounded-full border border-[#C15F22]/20 bg-[#C15F22]/[0.07] px-2.5 py-1 font-mono text-[11px] font-semibold text-[#C15F22]">
          {scoreLabel(item.score)} / 10
        </span>
      </div>

      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="group mt-4 block"
      >
        <h3 className="text-[16px] font-semibold leading-snug tracking-[-0.01em] text-text-primary transition-colors group-hover:text-[#C15F22]">
          {item.title}
        </h3>
        <p className="mt-2.5 text-[13px] leading-relaxed text-text-secondary">{item.summary}</p>
      </a>

      {item.whyItMatters ? (
        <div className="mt-4 rounded-xl border-l-2 border-[#C15F22]/60 bg-[#C15F22]/[0.045] px-3.5 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#C15F22]">为什么重要</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-secondary">{item.whyItMatters}</p>
        </div>
      ) : null}

      <div className="mt-auto pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {meta ? (
            <span
              className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]"
              style={{ backgroundColor: `${meta.color}12`, color: meta.color }}
            >
              {meta.label}
            </span>
          ) : null}
          {item.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded-sm bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
              #{tag}
            </span>
          ))}
        </div>

        {detailAvailable ? (
          <details className="group/details mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer list-none font-mono text-[11px] text-text-muted transition hover:text-text-primary [&::-webkit-details-marker]:hidden">
              <span className="inline-flex items-center gap-1.5">
                展开技术细节
                <span className="transition-transform group-open/details:rotate-90">→</span>
              </span>
            </summary>
            <div className="mt-3 space-y-3 text-[12px] leading-relaxed text-text-secondary">
              {item.keyDetails ? <Detail label="关键细节" text={item.keyDetails} /> : null}
              {item.background ? <Detail label="背景补充" text={item.background} /> : null}
              {item.communityDiscussion ? <Detail label="社区观点" text={item.communityDiscussion} /> : null}
              {item.references.length > 0 ? (
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">参考来源</div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {item.references.map((reference, refIndex) => (
                      <a
                        key={reference.url}
                        href={reference.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#C15F22] hover:underline"
                      >
                        {reference.title || `来源 ${refIndex + 1}`} ↗
                      </a>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  )
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <p className="mt-1">{text}</p>
    </div>
  )
}
