export interface Article {
  slug: string
  title: string
  excerpt: string
  date: string
  tags: string[]
  content: string
}

export const articles: Article[] = [
  {
    slug: 'vibecoding-workflow',
    title: '我的 Vibecoding 工作流：Claude Code 为主力的 AI 协作实践',
    excerpt: '分享我以 Claude Code 为核心，GPT 和 Gemini 为辅助的日常开发协作模式，以及这套工作流如何改变产品开发的效率与质量。',
    date: '2024-12',
    tags: ['Vibecoding', 'Claude Code', 'AI 协作'],
    content: '在过去一年中，我的工作方式发生了根本性的变化...',
  },
  {
    slug: 'ar-hud-product-lessons',
    title: 'AR HUD 量产：从概念到定点的产品方法论',
    excerpt: '复盘 AR HUD 产品从早期概念验证到主机厂量产定点的完整历程，提炼硬科技产品落地的关键方法论。',
    date: '2023-08',
    tags: ['AR HUD', '产品方法论', '量产'],
    content: '回顾 AR HUD 的产品化历程，最深的感悟是...',
  },
  {
    slug: 'robot-product-thinking',
    title: '机器人产品思维：技术驱动还是场景驱动？',
    excerpt: '基于多年机器人产品经验，探讨机器人产品定义中技术可行性与场景需求之间的平衡。',
    date: '2022-05',
    tags: ['机器人', '产品思维', '场景驱动'],
    content: '在机器人行业做产品，最常见的问题是...',
  },
  {
    slug: 'spatial-computing-future',
    title: '空间计算的下一个十年：从 AR 到具身智能',
    excerpt: '从 AR HUD 的实践出发，展望空间计算与具身智能的融合趋势，探索人机交互的未来形态。',
    date: '2024-03',
    tags: ['空间计算', '具身智能', '未来趋势'],
    content: '当我们谈论空间计算时，大多数人想到的是 VR/AR 头显...',
  },
]
