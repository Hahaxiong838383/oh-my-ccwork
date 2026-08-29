'use client'

import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { MagicCard } from '@/components/ui/MagicCard'
import { profile } from '@/data/profile'
import { Radar, Network, Brain, BookOpen } from 'lucide-react'

interface Capability {
  icon: typeof Radar
  tint: string
  title: string
  subtitle: string
  ability: string
  implementation: string
  value: string
}

const capabilities: Capability[] = [
  {
    icon: Radar,
    tint: '#5BA7FF',
    title: '公司战略洞察与经营决策系统',
    subtitle: 'PEST 外部雷达 / Growth Insight / AI Ontology 一体化',
    ability:
      '持续连接外部信号、产品线经营数据与公司目标，形成有证据、可人审、可验证的经营建议。',
    implementation:
      'PEST 战略感知 + Growth Insight 产品线投影 + AI Ontology 目标与事实关系图 · 证据治理 · 人审决策 · 结果回流校准。',
    value:
      '把战略分析从定期写报告升级为「持续感知—形成判断—人审决策—结果验证」的公司经营能力。',
  },
  {
    icon: Network,
    tint: '#F4A35D',
    title: 'Agent 工具 × 飞书生态深度打通',
    subtitle: '不套互联网公司通用 AI 方案，把 AI 嫁接到团队天天用的工作流里',
    ability:
      '把多智能体能力直接落到飞书 21 个业务节点（IM / 文档 / 知识库 / 多维表格 / 日历 / 会议 / 任务 等）。',
    implementation:
      'lark-cli + EvoDesk 客户端 · 飞书 skill 接入 Claude / GPT-Codex / Grok 三引擎 · 能力域路由 + 分层验证。',
    value:
      '为硬科技公司数字化与 AI 化提供可复制范式——AI 能力零迁移成本落在原有工作流，不打破团队协同。',
  },
  {
    icon: Brain,
    tint: '#A78BFA',
    title: 'EvoDesk 个人记忆与 Agent 自进化',
    subtitle: '跨 session 持续累积，技能随时间复利',
    ability:
      '个人项目记忆 / 决策记录 / 失败教训 / 反幻觉规则跨 session 持续沉淀，agent skill 基于反馈自动迭代。',
    implementation:
      '工作 / 情景 / 语义 / 程序 / 元认知 五层记忆架构 · 自进化 ROI 排序 + 测试自动生成 + patch 回滚 + 置信度学习。',
    value:
      '决策依据可追溯到原始事实，agent 越用越懂使用者；技能与判断力随时间复利，不靠重启重新学一遍。',
  },
  {
    icon: BookOpen,
    tint: '#34D399',
    title: '飞书作为 Agent 的外挂记忆与知识库',
    subtitle: '团队共享的最新研究底座，不是各自刷信息流',
    ability:
      '把飞书知识库变成 agent 可检索、可注入 LLM 上下文的外挂记忆；AI 前沿论文 / 行业热点持续归档。',
    implementation:
      'lark-wiki + lark-doc skill · 中文 FTS5 + 第五路注入 · 前沿调研每日自动入库 + 摘要分类。',
    value:
      'AI 前沿论文与热点论点的获取数量和及时性大幅提升；团队所有人共享同一份"最新研究底座"，研究判断从搜集转向决策。',
  },
]

const statBadges: { label: string; sub: string }[] = [
  { label: '外部感知', sub: '持续扫描信号' },
  { label: '产品线洞察', sub: '投影经营影响' },
  { label: '公司大脑', sub: '连接目标事实' },
  { label: '证据治理', sub: '判断有据可查' },
  { label: '人审决策', sub: '责任不交给 AI' },
  { label: '任务执行', sub: '决策进入行动' },
  { label: '结果验证', sub: '回收真实结果' },
  { label: '持续校准', sub: '闭环优化判断' },
]

export function AIWorkflow() {
  return (
    <SectionWrapper className="border-y border-border">
      <SectionTitle
        label="AI Operating System"
        title="不是会用 AI，是用 AI 重构部门生产力"
      />

      <p className="mb-12 max-w-3xl text-base leading-relaxed text-text-secondary">
        独立构建的 AI 工作操作系统 <span className="text-text-primary font-medium">EvoDesk</span>，把多智能体能力深度耦合到飞书生态，覆盖战略情报、个人记忆、知识沉淀、前沿研究
        四条线——不套用互联网公司通用 AI 方案，而是给硬科技团队的数字化与 AI 化提供一个可复制的部门级范式。
      </p>

      {/* 4 张能力卡 · 能力 → 实现 → 价值 */}
      <div className="mb-12 grid gap-5 md:grid-cols-2">
        {capabilities.map((cap, i) => {
          const Icon = cap.icon
          return (
            <BlurFade key={cap.title} delay={0.05 + i * 0.08}>
              <MagicCard
                className="capability-card h-full"
                gradientColor={`${cap.tint}1A`}
              >
                <div className="p-6">
                  <div className="mb-4 flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border"
                      style={{
                        borderColor: `${cap.tint}55`,
                        background: `${cap.tint}14`,
                        color: cap.tint,
                      }}
                    >
                      <Icon size={20} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold text-text-primary md:text-lg">
                        {cap.title}
                      </h3>
                      <p className="mt-1 font-mono text-[11px] text-text-muted">
                        {cap.subtitle}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-3 text-sm leading-relaxed">
                    <Row label="能力" tint={cap.tint} text={cap.ability} />
                    <Row label="实现" tint={cap.tint} text={cap.implementation} />
                    <Row label="价值" tint={cap.tint} text={cap.value} highlight />
                  </div>
                </div>
              </MagicCard>
            </BlurFade>
          )
        })}
      </div>

      {/* 数字治理价值带 */}
      <BlurFade delay={0.45}>
        <div className="rounded-xl border border-border bg-bg-card p-5 md:p-6">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <div className="font-mono text-xs uppercase tracking-widest text-text-muted">
              数字化治理价值层
            </div>
            <div className="hidden text-[11px] text-text-muted md:block">
              人 + AI 工作系统 · 部门级可复制范式
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-4 lg:grid-cols-8">
            {statBadges.map((s) => (
              <div key={s.sub} className="text-left">
                <div className="font-mono text-sm font-semibold text-text-primary md:text-base">
                  {s.label}
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-text-muted">
                  {s.sub}
                </div>
              </div>
            ))}
          </div>
        </div>
      </BlurFade>

      {/* 分层 AI 架构（EvoDesk 自研，非 Dify / n8n 通用方案） */}
      <BlurFade delay={0.55}>
        <div className="mt-8 rounded-xl border border-border bg-bg-card/60 p-5 md:p-6">
          <div className="mb-5 flex items-baseline justify-between gap-3">
            <div className="font-mono text-xs uppercase tracking-widest text-text-muted">
              分层 AI 架构 · EvoDesk 自研
            </div>
            <div className="hidden text-[11px] text-text-muted md:block">
              三引擎动态模型池 · 版本随路由更新
            </div>
          </div>

          {/* 引擎层只展示稳定的模型家族，具体版本由路由层动态选择。 */}
          <div className="mb-6">
            <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">
              引擎层 · Engines
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {profile.aiToolchain.map((tool) => (
                <div
                  key={tool.name}
                  className="rounded-lg border border-border/70 bg-bg-secondary/35 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      {tool.name}
                    </span>
                    <span
                      className="rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider"
                      style={{ borderColor: `${tool.tint}55`, color: tool.tint }}
                    >
                      {tool.role}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-text-muted">
                    {tool.desc}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
              展示模型家族，不锁定具体版本；EvoDesk 按任务类型、上下文与可用性自动选择当前模型。
            </p>
          </div>

          {/* 编排层 / 能力层 / 基础设施 三列 */}
          <div className="grid gap-5 md:grid-cols-3">
            <ArchColumn
              tint="#F4A35D"
              label="编排层 · Orchestration"
              items={[
                'autoRouteEngine 自动路由',
                'GWT 信息黑板（blackboard.md）',
                'scheduler 定时任务',
                'n8n / Dify workflow automation',
                'multi-session 多会话并行',
                'codex exec 直调长任务',
              ]}
            />
            <ArchColumn
              tint="#A78BFA"
              label="能力层 · Skills"
              items={[
                'lark-* 19 个飞书 skill 矩阵',
                '战略感知 / Growth Insight / AI Ontology',
                'codex review / 对抗审查 / rescue',
                'brain 知识系统 v0.14',
                'ai-news-radar / theory-radar / github-radar',
              ]}
            />
            <ArchColumn
              tint="#34D399"
              label="基础设施 · Infra"
              items={[
                '五层记忆架构（工作 / 情景 / 语义 / 程序 / 元认知）',
                '中文 FTS5 + 第五路注入',
                'Verifier 分层验证（规则 / 缓存 / 模型复核）',
                '自进化 v2（ROI 排序 / patch 回滚 / 置信度学习）',
                'Air → Mini → Studio 三机记忆同步',
              ]}
            />
          </div>
        </div>
      </BlurFade>
    </SectionWrapper>
  )
}

function Row({
  label,
  tint,
  text,
  highlight = false,
}: {
  label: string
  tint: string
  text: string
  highlight?: boolean
}) {
  return (
    <div className="grid grid-cols-[44px_1fr] items-baseline gap-3">
      <span
        className="font-mono text-[11px] uppercase tracking-[0.12em]"
        style={{ color: tint }}
      >
        {label}
      </span>
      <span className={highlight ? 'text-text-primary' : 'text-text-secondary'}>
        {text}
      </span>
    </div>
  )
}

function ArchColumn({
  tint,
  label,
  items,
}: {
  tint: string
  label: string
  items: string[]
}) {
  return (
    <div
      className="rounded-lg border bg-bg-card/40 p-4"
      style={{ borderColor: `${tint}30` }}
    >
      <div
        className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em]"
        style={{ color: tint }}
      >
        {label}
      </div>
      <ul className="space-y-2 text-[13px] leading-relaxed text-text-secondary">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <span
              className="mt-2 h-[3px] w-[3px] shrink-0 rounded-full"
              style={{ background: tint }}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
