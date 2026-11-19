'use client'

import Link from 'next/link'
import { SectionWrapper } from '@/components/layout/SectionWrapper'
import { SectionTitle } from '@/components/shared/SectionTitle'
import { BlurFade } from '@/components/ui/BlurFade'
import { MagicCard } from '@/components/ui/MagicCard'

const choices = [
  {
    title: '让对话接得上',
    text: '小可和 MyJavis 共用 Rust 重写的实时双向全双工语音引擎。识别、回答、语音合成流式衔接，也处理用户中途插话。',
    stack: 'Rust / Tokio · LiveKit / WebRTC · 流式 ASR—LLM—TTS',
    href: '/work/myjavis-voice-companion',
    color: '#5BA7FF',
  },
  {
    title: '少重复交代背景',
    text: 'H 平台在任务前查找相关记忆和知识页，筛选、去重后交给模型。记错的内容可以改，过期内容可以删除。',
    stack: 'ai-memory · SQLite FTS5 全文检索 + 向量检索 · 注入长度与超时限制',
    href: '/work/h-platform-ai-assistant',
    color: '#A78BFA',
  },
  {
    title: '任务做完，也要送到',
    text: '长任务由独立 Worker（执行进程）在后台运行。Harness 管理引擎的规则、技能、工具与权限；结果收到发送回执后才记为完成。',
    stack: 'Node.js · Agent Harness · SQLite 待发送队列 · 飞书 SDK',
    href: '/work/h-platform-ai-assistant',
    color: '#F4A35D',
  },
  {
    title: '让画面适应曲面玻璃',
    text: '全车窗 AR HUD 的 Warp 原型会预先调整画面形状，抵消投影变形。外屏实时验证已完成，真实挡风玻璃标定还在推进。',
    stack: 'Swift · ScreenCaptureKit 桌面采集 · Metal GPU 预畸变',
    href: '/work/full-window-ar-hud-ai-cockpit',
    color: '#34D399',
  },
]

export function AIWorkflow() {
  return (
    <SectionWrapper className="border-y border-border">
      <SectionTitle label="技术取舍" title="技术为什么这样选" />
      <p className="mb-8 max-w-3xl text-base leading-relaxed text-text-secondary">
        我会把使用中遇到的问题拆到技术方案里，再用原型验证。这里是几个正在做的选择。
      </p>
      <div className="grid gap-5 md:grid-cols-2">
        {choices.map((choice, i) => (
          <BlurFade key={choice.title} delay={i * 0.08}>
            <Link href={choice.href} className="block h-full">
              <MagicCard className="h-full" gradientColor={`${choice.color}1A`}>
                <div className="p-6">
                  <h3 className="mb-3 text-lg font-semibold text-text-primary">{choice.title}</h3>
                  <p className="text-sm leading-relaxed text-text-secondary">{choice.text}</p>
                  <p className="mt-4 border-t border-border pt-3 text-sm leading-relaxed text-text-muted">{choice.stack}</p>
                  <span className="mt-4 inline-block text-sm text-accent">查看项目 →</span>
                </div>
              </MagicCard>
            </Link>
          </BlurFade>
        ))}
      </div>
    </SectionWrapper>
  )
}
