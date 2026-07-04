// AI 前沿资讯雷达 —— 统一数据契约
// 资讯流来自 aihot.virxact.com 公开 API（多分类聚合）；
// 深度论文流来自 multica theory-radar agent（arXiv 5 段式分析，webhook 推送）。

export type RadarCategory = 'ai-models' | 'ai-products' | 'industry' | 'paper' | 'tip'

// 单条资讯（归一化后）
export interface RadarItem {
  id: string
  title: string
  titleEn?: string | null
  url: string
  source: string
  publishedAt: string | null // ISO 8601 UTC
  summary?: string | null
  category: RadarCategory | null
}

// 一次聚合的结果
export interface RadarFeed {
  items: RadarItem[]
  fetchedAt: string // ISO，本次聚合运行的时间（用于「上次同步」诚实展示）
  ok: boolean // 实时拉取是否成功（失败时前端降级，绝不假装实时）
  sourceCount: number // 去重后涉及的信源数
}

// ── 深度论文流（theory-radar agent 推送） ──
export interface TheoryPaper {
  index: number
  title: string
  arxivId?: string
  url: string
  published?: string // 论文真实发布日期 YYYY-MM-DD（arXiv published），非上线日
  category?: string
  score?: number // 认知重合度评分（agent 评定，0-100）
  finding?: string // 核心发现
  llmLink?: string // 与 LLM 连接
  insight?: string // 研究启示
}

export interface TheoryReport {
  date: string // YYYY-MM-DD
  edition?: number // 第 N 期
  summary?: string // 今日趋势综述（1 句话）
  papers: TheoryPaper[]
  generatedAt: string // ISO，agent 生成时间
}

// 分类元数据：标签 + 点缀色（与暖白主题点缀色一致）
export const CATEGORY_META: Record<RadarCategory, { label: string; color: string }> = {
  'ai-models': { label: '模型发布', color: '#6D5BD0' },
  'ai-products': { label: '产品发布', color: '#0071E3' },
  industry: { label: '行业动态', color: '#B7791F' },
  paper: { label: '论文研究', color: '#16A34A' },
  tip: { label: '技巧观点', color: '#52525B' },
}

export const CATEGORY_ORDER: RadarCategory[] = [
  'ai-models',
  'ai-products',
  'industry',
  'paper',
  'tip',
]

// 把 ISO 时间确定性地格式化为北京时间 "MM-DD HH:mm"
// 用手动 +8 偏移后读 UTC 字段，结果与运行环境时区无关 → 不会 SSR/CSR 水合不一致
export function formatBJTime(iso: string | null | undefined): string {
  if (!iso) return ''
  // 归一化非标准格式（"2026-06-14 12:00:00" 在 Safari 会 Date.parse→NaN，触发水合不一致）
  let s = iso.trim().replace(' ', 'T')
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z'
  const t = Date.parse(s)
  if (Number.isNaN(t)) return ''
  const d = new Date(t + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
