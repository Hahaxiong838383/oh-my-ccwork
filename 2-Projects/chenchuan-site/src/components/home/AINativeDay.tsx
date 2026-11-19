'use client'

import { Radar, Network, Activity, Archive } from 'lucide-react'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'

interface DayEntry {
  time: string
  icon: typeof Radar
  tint: string
  title: string
  points: string[]
  stack: string
}

const entries: DayEntry[] = [
  {
    time: '研究',
    icon: Radar,
    tint: '#5BA7FF',
    title: '找到值得做的问题',
    points: [
      '结合使用反馈、行业信息和项目资料，确定要解决的问题。',
      'AI 帮我检索和整理资料，重要判断回到原始来源核对。',
    ],
    stack: 'PEST 行业分析 · 资料检索 · 飞书知识库',
  },
  {
    time: '开发',
    icon: Network,
    tint: '#F4A35D',
    title: '做一个能试用的版本',
    points: [
      '我写清使用场景和验收条件，参与技术选型，再借助 AI 开发。',
      '根据任务使用 Claude、GPT / Codex 或 Grok，保留代码和决策记录。',
    ],
    stack: 'EvoDesk · 多模型协作 · Git 版本管理',
  },
  {
    time: '验收',
    icon: Activity,
    tint: '#EAB308',
    title: '把自己当成使用者',
    points: [
      '在真实设备上试对话、点页面，也检查断线、中断和恢复。',
      '上线前保留回滚点；出了问题，记录原因并补测试。',
    ],
    stack: '真机验证 · 浏览器测试 · 日志排查',
  },
  {
    time: '积累',
    icon: Archive,
    tint: '#F472B6',
    title: '下次不用从头说明',
    points: [
      '把已确认的决定和踩过的坑留下来，供后续任务查阅。',
      '重复有效的做法整理成 Skills（可复用工作方法），工具通过 MCP 等接口接入。',
    ],
    stack: '分层记忆 · Skills · MCP 工具连接协议',
  },
]

export function AINativeDay() {
  return (
    <SectionWrapper className="border-y border-border">
      <SectionTitle
        label="工作方式"
        title="我怎样把想法做出来"
      />

      <p className="mb-12 max-w-3xl text-base leading-relaxed text-text-secondary">
        独立软件项目由我一个人 vibe coding 完成，没有团队，AI 是我的手脚。
        公司产品的硬件、供应链和量产，则由跨职能团队共同推进。
      </p>

      <div className="relative">
        {/* 竖向时间线轨道 */}
        <div className="absolute left-[17px] top-2 bottom-2 w-px bg-gradient-to-b from-sky-600/40 via-amber-600/30 to-pink-300/40 md:left-[97px]" />

        <div className="space-y-8">
          {entries.map((entry, i) => {
            const Icon = entry.icon
            return (
              <BlurFade key={entry.time} delay={0.05 + i * 0.08}>
                <div className="relative grid grid-cols-[36px_1fr] gap-4 md:grid-cols-[80px_36px_1fr] md:gap-5">
                  {/* 时间（仅桌面） */}
                  <div className="hidden md:block">
                    <div className="pt-1 text-right font-mono text-xl font-semibold text-text-primary">
                      {entry.time}
                    </div>
                  </div>

                  {/* Icon 节点 */}
                  <div className="relative flex items-start justify-center">
                    <div
                      className="z-10 flex h-9 w-9 items-center justify-center rounded-full border"
                      style={{
                        background: `${entry.tint}1A`,
                        borderColor: `${entry.tint}66`,
                        color: entry.tint,
                      }}
                    >
                      <Icon size={18} />
                    </div>
                  </div>

                  {/* 卡片 */}
                  <div
                    className="depth-panel rounded-xl border bg-bg-card p-5"
                    style={{ borderColor: `${entry.tint}22` }}
                  >
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <h3 className="text-base font-semibold text-text-primary md:text-lg">
                        {entry.title}
                      </h3>
                      <span className="font-mono text-xs text-text-muted md:hidden">
                        {entry.time}
                      </span>
                    </div>
                    <ul className="mb-3 space-y-1.5 text-sm leading-relaxed text-text-secondary">
                      {entry.points.map((p) => (
                        <li key={p} className="flex items-start gap-2">
                          <span
                            className="mt-2 h-[3px] w-[3px] shrink-0 rounded-full"
                            style={{ background: entry.tint }}
                          />
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                    <div
                      className="font-mono text-[11px] uppercase tracking-[0.12em]"
                      style={{ color: entry.tint }}
                    >
                      {entry.stack}
                    </div>
                  </div>
                </div>
              </BlurFade>
            )
          })}
        </div>
      </div>
    </SectionWrapper>
  )
}
