'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { BlurFade } from '@/components/ui/BlurFade'
import type { TheoryReport } from '@/lib/radar/types'

const GREEN = '#16A34A'
const QUICK_PICK_COUNT = 7
const isHttp = (u?: string) => !!u && /^https?:\/\//i.test(u)
const isExpert = (r: TheoryReport) => (r.summary || '').includes('专家追踪专题')
const reportLabel = (r: TheoryReport) => r.date.slice(5)

function monthLabel(month: string) {
  const [year, rawMonth] = month.split('-')
  return `${year}年${Number(rawMonth)}月`
}

function groupByMonth(list: TheoryReport[]) {
  return list.reduce<Array<{ month: string; reports: Array<{ report: TheoryReport; index: number }> }>>(
    (groups, report, index) => {
      const month = report.date.slice(0, 7)
      const last = groups[groups.length - 1]
      if (last?.month === month) {
        last.reports.push({ report, index })
      } else {
        groups.push({ month, reports: [{ report, index }] })
      }
      return groups
    },
    [],
  )
}

// 深度论文流：theory-radar agent 的 arXiv 5 段式拆解（差异化硬核层）
// 多期归档：最新一期（webhook/seed）+ 历史归档，可切换查看
export function TheoryReportSection({ reports }: { reports: TheoryReport[] }) {
  const list = reports.filter(Boolean)
  const [idx, setIdx] = useState(0)
  const sectionRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={sectionRef} className="rounded-3xl border border-[#16A34A]/20 bg-[#16A34A]/[0.04] p-6 md:p-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em]" style={{ color: GREEN }}>
            深度拆解 · 理论雷达
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-text-primary md:text-2xl">
            脑科学 × LLM 前沿论文
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-text-secondary">
            从 arXiv 等学术来源筛选相关论文，按期整理中文解读，并保留原文链接。
            {list.length > 1 && `下方可切换查看历史归档，共 ${list.length} 期。`}
          </p>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#16A34A]/30 bg-bg-card/60 px-6 py-12 text-center">
          <p className="text-sm text-text-secondary">暂时没有可展示的论文解读。</p>
          <p className="mt-1.5 font-mono text-[11px] text-text-muted">
            可先查看上方行业资讯
          </p>
        </div>
      ) : (
        <Browser list={list} idx={idx} setIdx={setIdx} sectionRef={sectionRef} />
      )}
    </div>
  )
}

function Browser({
  list,
  idx,
  setIdx,
  sectionRef,
}: {
  list: TheoryReport[]
  idx: number
  setIdx: (i: number) => void
  sectionRef: RefObject<HTMLDivElement | null>
}) {
  const report = list[idx] ?? list[0]
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [sectionRect, setSectionRect] = useState<DOMRect | null>(null)
  const quickReports = list.slice(0, QUICK_PICK_COUNT)
  const selectedOutsideQuick = idx >= QUICK_PICK_COUNT
  const archiveGroups = useMemo(() => groupByMonth(list), [list])

  const syncSectionRect = () => {
    setSectionRect(sectionRef.current?.getBoundingClientRect() ?? null)
  }

  const openArchive = () => {
    syncSectionRect()
    setArchiveOpen(true)
  }

  useEffect(() => {
    if (!archiveOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArchiveOpen(false)
    }
    const onMove = () => syncSectionRect()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [archiveOpen])

  return (
    <>
      {/* 期数选择器 */}
      {list.length > 1 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {quickReports.map((r, i) => {
            const active = i === idx
            const badge = i === 0 ? '最新' : isExpert(r) ? '专家' : null
            return (
              <button
                key={`${r.date}-${i}`}
                onClick={() => setIdx(i)}
                className={`shrink-0 rounded-lg border px-3 py-1.5 font-mono text-[12px] transition-colors ${
                  active
                    ? 'border-[#16A34A] bg-[#16A34A] text-white'
                    : 'border-border bg-bg-card text-text-secondary hover:border-[#16A34A]/50 hover:text-text-primary'
                }`}
              >
                {reportLabel(r)}
                {badge && (
                  <span className={`ml-1 text-[10px] ${active ? 'text-white/80' : 'text-text-muted'}`}>
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
          {selectedOutsideQuick && (
            <button
              onClick={openArchive}
              className="shrink-0 rounded-lg border border-[#16A34A]/50 bg-[#16A34A]/10 px-3 py-1.5 font-mono text-[12px] text-[#15803D] transition-colors hover:border-[#16A34A] hover:bg-[#16A34A]/15"
            >
              当前 {reportLabel(report)}
              {isExpert(report) && <span className="ml-1 text-[10px] text-text-muted">专家</span>}
            </button>
          )}
          <button
            onClick={openArchive}
            className="shrink-0 rounded-lg border border-border bg-bg-card px-3 py-1.5 font-mono text-[12px] text-text-secondary transition-colors hover:border-[#16A34A]/50 hover:text-text-primary"
          >
            全部归档 {list.length}期
          </button>
        </div>
      )}

      {archiveOpen && (
        <ArchiveDialog
          groups={archiveGroups}
          currentIndex={idx}
          sectionRect={sectionRect}
          onClose={() => setArchiveOpen(false)}
          onSelect={(nextIndex) => {
            setIdx(nextIndex)
            setArchiveOpen(false)
          }}
        />
      )}

      {/* 当前期元信息 */}
      <div className="mb-4 flex items-center justify-between gap-3 font-mono text-[11px] text-text-muted">
        <span>
          {isExpert(report) ? '专家追踪专题' : '日报归档'} · {report.date}
        </span>
        <span>共 {report.papers.length} 篇</span>
      </div>

      {report.summary && (
        <p className="mb-5 rounded-xl border border-border bg-bg-card px-4 py-3 text-sm leading-relaxed text-text-secondary">
          <span className="font-medium text-text-primary">本期趋势 · </span>
          {report.summary}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {report.papers.map((p, i) => (
          <BlurFade key={`${report.date}-${p.arxivId || p.index}-${i}`} delay={Math.min(i, 8) * 0.04}>
            <article className="flex h-full flex-col rounded-2xl border border-border bg-bg-card p-5">
              <div className="mb-2 flex items-start justify-between gap-3">
                {isHttp(p.url) ? (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[15px] font-semibold leading-snug text-text-primary transition-colors hover:text-accent"
                  >
                    {p.title}
                  </a>
                ) : (
                  <span className="text-[15px] font-semibold leading-snug text-text-primary">{p.title}</span>
                )}
                {typeof p.score === 'number' && (
                  <span
                    className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[12px] font-medium"
                    style={{ backgroundColor: `${GREEN}14`, color: GREEN }}
                  >
                    {p.score}
                  </span>
                )}
              </div>
              <div className="mb-3 font-mono text-[11px] text-text-muted">
                {p.arxivId ? `arXiv:${p.arxivId}` : ''}
                {p.category ? ` · ${p.category}` : ''}
                {p.published ? ` · 发布 ${p.published}` : ''}
              </div>
              <div className="space-y-2 text-[13px] leading-relaxed">
                {p.finding && <Line label="核心发现" text={p.finding} />}
                {p.llmLink && <Line label="与 LLM 连接" text={p.llmLink} />}
                {p.insight && <Line label="研究启示" text={p.insight} />}
              </div>
            </article>
          </BlurFade>
        ))}
      </div>
    </>
  )
}

function ArchiveDialog({
  groups,
  currentIndex,
  sectionRect,
  onClose,
  onSelect,
}: {
  groups: Array<{ month: string; reports: Array<{ report: TheoryReport; index: number }> }>
  currentIndex: number
  sectionRect: DOMRect | null
  onClose: () => void
  onSelect: (index: number) => void
}) {
  const panelStyle = getArchivePanelStyle(sectionRect)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/25 px-3 py-4 backdrop-blur-sm md:block md:px-0 md:py-0"
      role="dialog"
      aria-modal="true"
      aria-label="理论雷达全部归档"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-3xl border border-[#16A34A]/20 bg-[#F8FBF5] shadow-2xl shadow-[#14532D]/20 md:fixed"
        style={panelStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#16A34A]/15 px-5 py-4 md:px-6">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: GREEN }}>
              archive index
            </div>
            <h3 className="mt-1 text-lg font-semibold tracking-tight text-text-primary">全部理论雷达归档</h3>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              按月份分组查看，最近一期仍保留在页面快捷区。
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full border border-border bg-white/70 px-3 py-1.5 font-mono text-[12px] text-text-secondary transition-colors hover:border-[#16A34A]/50 hover:text-text-primary"
          >
            关闭
          </button>
        </div>

        <div className="max-h-[66vh] overflow-y-auto px-5 py-5 md:max-h-[calc(var(--archive-panel-max-height,82vh)-86px)] md:px-6">
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.month}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="font-mono text-[12px] font-medium text-text-primary">
                    {monthLabel(group.month)}
                  </h4>
                  <span className="font-mono text-[10px] text-text-muted">{group.reports.length}期</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.reports.map(({ report, index }) => {
                    const active = index === currentIndex
                    return (
                      <button
                        key={`${report.date}-${index}`}
                        onClick={() => onSelect(index)}
                        className={`rounded-2xl border px-4 py-3 text-left transition-colors ${
                          active
                            ? 'border-[#16A34A] bg-[#16A34A] text-white'
                            : 'border-border bg-white/70 text-text-secondary hover:border-[#16A34A]/50 hover:bg-white hover:text-text-primary'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-[13px] font-medium">{report.date}</span>
                          <span className={`font-mono text-[10px] ${active ? 'text-white/80' : 'text-text-muted'}`}>
                            {report.papers.length}篇
                          </span>
                        </div>
                        <div className={`mt-1 text-xs ${active ? 'text-white/80' : 'text-text-muted'}`}>
                          {isExpert(report) ? '专家追踪专题' : index === 0 ? '最新日报' : '日报归档'}
                        </div>
                        {report.summary && (
                          <p className={`mt-2 truncate text-[12px] ${active ? 'text-white/75' : 'text-text-secondary'}`}>
                            {report.summary}
                          </p>
                        )}
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function getArchivePanelStyle(sectionRect: DOMRect | null) {
  if (!sectionRect || typeof window === 'undefined' || window.innerWidth < 768) return undefined

  const margin = 24
  const width = Math.min(1080, sectionRect.width - 48, window.innerWidth - margin * 2)
  const left = Math.min(
    Math.max(sectionRect.left + (sectionRect.width - width) / 2, margin),
    window.innerWidth - width - margin,
  )
  const top = Math.max(sectionRect.top, margin)
  const maxHeight = Math.max(320, window.innerHeight - top - margin)

  return {
    left,
    top,
    width,
    maxHeight,
    '--archive-panel-max-height': `${maxHeight}px`,
  } as CSSProperties
}

function Line({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid grid-cols-[64px_1fr] gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.1em]" style={{ color: GREEN }}>
        {label}
      </span>
      <span className="text-text-secondary">{text}</span>
    </div>
  )
}
