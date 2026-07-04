'use client'

import { useMemo, useState } from 'react'
import { CATEGORY_META, CATEGORY_ORDER, formatBJTime } from '@/lib/radar/types'
import type { RadarCategory, RadarItem } from '@/lib/radar/types'

interface Props {
  items: RadarItem[]
}

type TabKey = 'all' | RadarCategory

const PAGE_SIZE = 60

export function RadarFeed({ items }: Props) {
  const [tab, setTab] = useState<TabKey>('all')
  const [visible, setVisible] = useState(PAGE_SIZE)

  // 切换分类时重置展示数量，避免跨 tab 残留
  const selectTab = (t: TabKey) => {
    setTab(t)
    setVisible(PAGE_SIZE)
  }

  // 只展示真有内容的分类 tab
  const available = useMemo(() => {
    const set = new Set<RadarCategory>()
    for (const it of items) if (it.category) set.add(it.category)
    return CATEGORY_ORDER.filter((c) => set.has(c))
  }, [items])

  const filtered = useMemo(
    () => (tab === 'all' ? items : items.filter((it) => it.category === tab)),
    [items, tab],
  )

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-bg-secondary px-6 py-16 text-center">
        <p className="text-sm text-text-secondary">
          信源正在同步中，稍后自动刷新。产线每 30 分钟运行一次。
        </p>
      </div>
    )
  }

  return (
    <div>
      {/* 分类 tab */}
      <div className="mb-7 flex flex-wrap gap-2">
        <TabButton active={tab === 'all'} onClick={() => selectTab('all')} label="全部" count={items.length} />
        {available.map((c) => (
          <TabButton
            key={c}
            active={tab === c}
            onClick={() => selectTab(c)}
            label={CATEGORY_META[c].label}
            color={CATEGORY_META[c].color}
            count={items.filter((it) => it.category === c).length}
          />
        ))}
        {/* 锚点链接（非筛选）：直达底部深度拆解区 */}
        <a
          href="#deep-dive"
          className="inline-flex items-center gap-1.5 rounded-full border border-[#16A34A]/40 bg-[#16A34A]/[0.06] px-3.5 py-1.5 text-[13px] font-medium text-[#16A34A] transition hover:border-[#16A34A]/70 hover:bg-[#16A34A]/[0.12]"
        >
          深度拆解
          <span className="font-mono text-[11px]">↓</span>
        </a>
      </div>

      {/* 卡片网格 */}
      <div className="grid gap-4 md:grid-cols-2">
        {filtered.slice(0, visible).map((it) => (
          <RadarCard key={it.id} item={it} />
        ))}
      </div>

      {/* 加载更多 */}
      {visible < filtered.length && (
        <div className="mt-8 flex justify-center">
          <button
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary px-6 py-2.5 text-[13px] font-medium text-text-secondary transition hover:border-border-hover hover:text-text-primary"
          >
            加载更多
            <span className="font-mono text-[11px] text-text-muted">
              已显示 {visible} / {filtered.length}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
  count,
  color,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  color?: string
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition ${
        active
          ? 'border-text-primary bg-text-primary text-bg-primary'
          : 'border-border bg-bg-secondary text-text-secondary hover:border-border-hover hover:text-text-primary'
      }`}
    >
      {color && !active && (
        <span className="h-[6px] w-[6px] rounded-full" style={{ backgroundColor: color }} />
      )}
      {label}
      <span className={`font-mono text-[11px] ${active ? 'text-bg-primary/70' : 'text-text-muted'}`}>
        {count}
      </span>
    </button>
  )
}

function RadarCard({ item }: { item: RadarItem }) {
  const meta = item.category ? CATEGORY_META[item.category] : null
  const time = formatBJTime(item.publishedAt)
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      className="group flex h-full flex-col rounded-2xl border border-border bg-bg-card p-5 transition duration-300 hover:-translate-y-0.5 hover:border-border-hover hover:shadow-[0_8px_26px_rgba(0,0,0,0.06)]"
    >
      <div className="mb-2.5 flex items-center justify-between gap-3 font-mono text-[11px] text-text-muted">
        <span className="flex items-center gap-1.5 truncate">
          {meta && (
            <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
          )}
          <span className="truncate">{item.source}</span>
        </span>
        <span className="shrink-0 tabular-nums">{time}</span>
      </div>

      <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-text-primary transition-colors group-hover:text-accent">
        {item.title}
      </h3>

      {item.summary && (
        <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-text-secondary">
          {item.summary}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between pt-3.5">
        {meta ? (
          <span
            className="rounded-sm px-1.5 py-0.5 font-mono text-[10px]"
            style={{ backgroundColor: `${meta.color}12`, color: meta.color }}
          >
            {meta.label}
          </span>
        ) : (
          <span />
        )}
        <span className="font-mono text-[12px] text-text-muted transition group-hover:translate-x-0.5 group-hover:text-text-primary">
          阅读原文 →
        </span>
      </div>
    </a>
  )
}
