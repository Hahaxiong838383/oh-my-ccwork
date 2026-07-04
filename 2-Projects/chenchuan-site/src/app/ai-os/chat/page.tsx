import type { Metadata } from 'next'
import { ChatWorkspace } from '@/components/ai-os/ChatWorkspace'
import { CLASSIC_DEMOS } from '@/data/classic-demos'

export const metadata: Metadata = {
  title: 'Talk With My AI · 陈川的战略镜像',
  description:
    '和陈川的 AI 战略镜像对话——架构冲突 / 极速交付 / 认知沉淀 / 失败诊断 / 跨界范式 5 类经典提问回放，自由提问 3 轮。',
}

// 服务端拿全部 featured demos 注入到客户端组件
export default function ChatPage() {
  const demos = CLASSIC_DEMOS.filter((d) => d.featured).sort(
    (a, b) => b.quality_score - a.quality_score,
  )

  return (
    <div className="relative min-h-screen bg-black text-white">
      <ChatWorkspace classicDemos={demos} />
    </div>
  )
}
