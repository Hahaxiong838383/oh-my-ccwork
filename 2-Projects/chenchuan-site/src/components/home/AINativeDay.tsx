'use client'

import { Radar, Network, RefreshCw, Layers, Activity, Archive } from 'lucide-react'
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
    time: '07:00',
    icon: Radar,
    tint: '#5BA7FF',
    title: '晨起 · Hermes 战略雷达自动入库',
    points: [
      '4 个 collector 通宵跑：政策 / 资本 / 技术成熟度 / 竞品动态',
      '每日近百条情报自动摘要 + 分类归档到飞书知识库',
      '10 分钟扫日报，标出今日值得深挖的 3-5 条主题',
    ],
    stack: 'Hermes pipeline · 4 collector · 影响因子矩阵',
  },
  {
    time: '09:00',
    icon: Network,
    tint: '#F4A35D',
    title: '任务规划 · 四引擎按能力域分工',
    points: [
      'Claude 负责复杂推理、任务架构与关键决策',
      'GPT / Codex 负责工程实现、多模态与对抗审查',
      'Gemini 负责长上下文研究与对照验证',
      'Grok 负责实时研究、前沿检索与 AI Ops',
      'autoRouteEngine 自动判断引擎归属',
    ],
    stack: 'EvoDesk 编排层 · GWT 信息黑板 · multi-session 并行',
  },
  {
    time: '11:00',
    icon: RefreshCw,
    tint: '#A78BFA',
    title: '跨设备同步 · 21 飞书业务节点',
    points: [
      'Air / Mini / Studio / NAS 四机决策上下文一致',
      '21 飞书节点（IM / 文档 / 知识库 / 多维表格 / 日历...）实时同步',
      '团队成员同步看到决策依据，跨人零知识漂移',
    ],
    stack: 'lark-cli · EvoDesk 客户端 · 19 飞书 skill 矩阵',
  },
  {
    time: '14:00',
    icon: Layers,
    tint: '#34D399',
    title: '项目协同 · 五层记忆零返工',
    points: [
      '工作 / 情景 / 语义 / 程序 / 元认知 五层记忆持续召回',
      '决策依据可追溯到原始事实证据，反幻觉锁死',
      '跨 session、跨设备、跨人零知识漂移',
    ],
    stack: '五层记忆架构 · 中文 FTS5 · 第五路注入',
  },
  {
    time: '17:00',
    icon: Activity,
    tint: '#EAB308',
    title: '复盘自进化 · Agent 技能 ROI 排序',
    points: [
      '今日触发的所有 agent 调用回归测试 + 置信度学习',
      'patch 自动回滚 + 失败教训沉淀到 feedback memory',
      '高 ROI skill 提权 / 低效路径下沉，明日 prompt 自动偏置',
    ],
    stack: '自进化 v2 · Verifier 三层验证（cheap / cache / Gemini Flash）',
  },
  {
    time: '22:00',
    icon: Archive,
    tint: '#F472B6',
    title: '收尾归档 · 日报 / 周报 / 月报自动生成',
    points: [
      '飞书云文档自动生成日报，累积成周报 + 月报',
      '知识库分类归档 + 与历史项目交叉索引',
      'Hermes 加载新 prompt 偏置，预备明日早班',
    ],
    stack: 'lark-doc skill · 知识库自动归档 · cron 调度',
  },
]

export function AINativeDay() {
  return (
    <SectionWrapper className="border-y border-border">
      <SectionTitle
        label="A day in AI-Native mode"
        title="一天的 AI Native 工作流"
      />

      <p className="mb-12 max-w-3xl text-base leading-relaxed text-text-secondary">
        不是会用 AI，是 living in AI-native mode。以下是真实工作日时间线 ——
        我独立构建的 AI 工作操作系统 <span className="text-text-primary font-medium">EvoDesk</span> 每天真实跑的状态，不是 mock 数据。
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
