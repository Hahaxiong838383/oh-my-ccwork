'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { ClassicDemo, DemoCategory } from '@/data/classic-demos'
import { CATEGORY_LABELS } from '@/data/classic-demos'
import { ReplayTimeline } from './ReplayTimeline'
import { FreeAskPanel } from './FreeAskPanel'
import { VoiceMirrorExperience } from './VoiceMirrorExperience'

interface ChatWorkspaceProps {
  classicDemos: ClassicDemo[]
}

export function ChatWorkspace({ classicDemos }: ChatWorkspaceProps) {
  const [activeDemoId, setActiveDemoId] = useState<string | null>(null)
  const [conversationMode, setConversationMode] = useState<'voice' | 'text'>('voice')
  const categoryGroups = groupByCategory(classicDemos)
  const activeDemo = activeDemoId ? classicDemos.find((d) => d.id === activeDemoId) ?? null : null

  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      {/* 顶部 ===== */}
      <header className="mb-8">
        <Link
          href="/"
          prefetch={false}
          className="mb-6 inline-flex items-center gap-1.5 text-[12px] text-white/55 transition hover:text-[#7FE5FF]"
        >
          <span aria-hidden>←</span>
          <span>返回主页</span>
        </Link>
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.3em] text-[#7FE5FF]/85">
          Talk With My AI · Live Demo
        </div>
        <h1 className="text-3xl font-bold text-white sm:text-4xl">
          陈川的<span className="text-[#7FE5FF]">战略镜像</span>
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/70">
          想了解陈川怎么用 AI 做产品决策？
          <span className="text-white/85">左边可直接开口聊 2 分钟，也可切换成文字问答</span>；或者
          <span className="text-white/85">右边点击「真实场景回放」</span>，
          看陈川和多个 AI 协作做决策的完整过程。无需技术背景，问产品 / 招聘 / 创业 /
          管理都可以。
        </p>
      </header>

      {/* 主体：左自由提问 · 右经典回放（lg+ 横向并列；mobile 纵向） ===== */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* 左：自由提问 ===== */}
        <div className="lg:col-span-7">
          <div className="mb-3 inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
            <button
              type="button"
              onClick={() => setConversationMode('voice')}
              className={`rounded-lg px-4 py-2 text-xs font-medium transition ${
                conversationMode === 'voice' ? 'bg-[#725EFF] text-white' : 'text-white/55 hover:text-white'
              }`}
            >
              实时语音 · 2 分钟
            </button>
            <button
              type="button"
              onClick={() => setConversationMode('text')}
              className={`rounded-lg px-4 py-2 text-xs font-medium transition ${
                conversationMode === 'text' ? 'bg-[#725EFF] text-white' : 'text-white/55 hover:text-white'
              }`}
            >
              文字问答 · 3 轮
            </button>
          </div>
          {conversationMode === 'voice' ? <VoiceMirrorExperience /> : <FreeAskPanel />}
        </div>

        {/* 右：经典提问 chip 列表 + inline 回放 ===== */}
        <div className="space-y-4 lg:col-span-5">
          <ClassicDemoSidebar
            categoryGroups={categoryGroups}
            activeDemoId={activeDemoId}
            onSelect={(id) => setActiveDemoId(id)}
            totalCount={classicDemos.length}
          />

          {activeDemo && (
            <div id="replay-area" className="scroll-mt-8">
              <ReplayTimeline demo={activeDemo} onClose={() => setActiveDemoId(null)} />
            </div>
          )}
        </div>
      </div>

      {/* 底部加微信引导 ===== */}
      <footer className="mt-10 rounded-lg border border-[#7FE5FF]/25 bg-[#7FE5FF]/[0.04] p-5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/85">
          想真正深聊？
        </div>
        <p className="text-sm leading-relaxed text-white/80">
          上面只是「战略镜像」的通用决策逻辑回放与有限自由提问。具体项目背景 /
          商业 context / 决策细节，
          <Link
            href="/contact"
            className="text-[#7FE5FF] underline-offset-2 hover:underline"
          >
            加陈川微信 →
          </Link>
          ，暗号「OS 访客」，他会给你更有杀伤力的建议。
        </p>
      </footer>
    </div>
  )
}

interface ClassicDemoSidebarProps {
  categoryGroups: Record<DemoCategory, ClassicDemo[]>
  activeDemoId: string | null
  onSelect: (id: string) => void
  totalCount: number
}

function ClassicDemoSidebar({
  categoryGroups,
  activeDemoId,
  onSelect,
  totalCount,
}: ClassicDemoSidebarProps) {
  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/85">
            真实场景回放
          </div>
          <div className="mt-1 text-[11px] text-white/55">
            点开看陈川怎么和 AI 一起做产品决策（免费）
          </div>
        </div>
        <span className="font-mono text-[10px] text-[#7FE5FF]/65">
          {totalCount} 条
        </span>
      </div>

      <div className="space-y-2.5">
        {(Object.entries(categoryGroups) as [DemoCategory, ClassicDemo[]][])
          .filter(([, demos]) => demos.length > 0)
          .map(([category, demos]) => (
            <div key={category}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-[#7FE5FF]/80">
                  {CATEGORY_LABELS[category]}
                </span>
                <span className="font-mono text-[9px] text-white/30 tabular-nums">
                  {demos.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {demos.map((demo) => (
                  <button
                    key={demo.id}
                    type="button"
                    onClick={() => {
                      onSelect(demo.id)
                      setTimeout(() => {
                        document
                          .getElementById('replay-area')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }, 50)
                    }}
                    className={`max-w-full rounded-md border px-2.5 py-1 text-left text-[11.5px] leading-snug transition ${
                      activeDemoId === demo.id
                        ? 'border-[#7FE5FF]/60 bg-[#7FE5FF]/[0.10] text-[#7FE5FF] shadow-[0_0_10px_rgba(127,229,255,0.18)]'
                        : 'border-white/15 bg-black/30 text-white/80 hover:border-[#7FE5FF]/40 hover:bg-[#7FE5FF]/[0.04] hover:text-white'
                    }`}
                  >
                    {demo.question}
                  </button>
                ))}
              </div>
            </div>
          ))}
      </div>
    </section>
  )
}

function groupByCategory(demos: ClassicDemo[]): Record<DemoCategory, ClassicDemo[]> {
  const groups: Record<DemoCategory, ClassicDemo[]> = {
    arch: [],
    speed: [],
    cognition: [],
    failure: [],
    crossover: [],
  }
  for (const d of demos) groups[d.category].push(d)
  return groups
}
