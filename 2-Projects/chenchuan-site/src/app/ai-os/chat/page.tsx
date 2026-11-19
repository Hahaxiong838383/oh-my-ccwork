import type { Metadata } from 'next'
import { ChatWorkspace } from '@/components/ai-os/ChatWorkspace'
import { CLASSIC_DEMOS } from '@/data/classic-demos'

export const metadata: Metadata = {
  title: '和陈川的 AI 聊聊',
  description:
    '通过语音、文字问答和整理后的决策示例，了解陈川的项目与产品思路。',
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
