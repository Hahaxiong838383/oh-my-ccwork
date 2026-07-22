// yuweiwan/large_AI_radar 静态 JSON 适配器 —— 雷达第二上游（2026-07-07 接入）
//
// 上游形态：GH Actions 每 30 分钟聚合 92 源/10 站（tophub/aibase/buzzing 等中文强覆盖），
// 把 data/latest-24h.json 直接 commit 回仓库 → raw.githubusercontent.com 即免费 JSON API，
// 基建在 GitHub（Fastly CDN），零服务器成本。挂了可 fork 一键自主（对冲个人仓 bus factor）。
//
// 文件 ~11MB（含 items / items_ai / items_all_raw 等多份列表，我们只用 items）。
// 因此模块内做 30 分钟缓存对齐上游更新节奏——比 aihot 的 5 分钟 TTL 更频繁地拉是纯浪费。
import type { RadarCategory, RadarItem } from './types'

const YUWEIWAN_URL =
  process.env.YUWEIWAN_RADAR_URL ||
  'https://raw.githubusercontent.com/yuweiwan/large_AI_radar/main/data/latest-24h.json'
const FETCH_TIMEOUT_MS = 20_000 // 11MB 大文件；韩国→gh raw 实测很快，超时留宽兜底慢网
const SOURCE_TTL_MS = 30 * 60 * 1000

interface YuweiwanRawItem {
  id?: unknown
  site_name?: unknown
  source?: unknown
  title?: unknown
  title_original?: unknown
  title_zh?: unknown
  title_en?: unknown
  url?: unknown
  published_at?: unknown
  first_seen_at?: unknown
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

// 只做有把握的映射（论文类特征词）；不确定就 null——null 仅出现在「全部」tab，不装懂
export function classifyYuweiwanItem(title: string, source: string): RadarCategory | null {
  const t = `${title} ${source}`.toLowerCase()
  if (/arxiv|论文|\bpaper\b/.test(t)) return 'paper'
  return null
}

// 系统边界：外部 JSON 逐条校验，脏条目丢弃（fail-soft），id 加 yw: 前缀防与 aihot id 空间冲撞
export function parseYuweiwanItems(raw: unknown): RadarItem[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { items?: unknown }).items
  if (!Array.isArray(list)) return []

  const out: RadarItem[] = []
  for (const it of list as YuweiwanRawItem[]) {
    const id = str(it?.id)
    const url = str(it?.url)
    const title = str(it?.title_zh) ?? str(it?.title) ?? str(it?.title_original)
    if (!id || !url || !title) continue
    const source = str(it?.source) ?? str(it?.site_name) ?? '未知来源'
    out.push({
      id: `yw:${id}`,
      title,
      titleEn: str(it?.title_en),
      url,
      source,
      publishedAt: str(it?.published_at) ?? str(it?.first_seen_at),
      summary: null,
      category: classifyYuweiwanItem(title, source),
    })
  }
  return out
}

type YuweiwanCache = { items: RadarItem[]; fetchedAt: number }
const g = globalThis as typeof globalThis & { __ywSourceCache?: YuweiwanCache }

// 拉取第二上游（带 30min 源级缓存）。任何失败 fail-soft 返回 []（或过期缓存），绝不拖垮主链路。
export async function fetchYuweiwanLatest(refreshSignal?: AbortSignal): Promise<RadarItem[]> {
  const cached = g.__ywSourceCache
  if (cached && Date.now() - cached.fetchedAt < SOURCE_TTL_MS) {
    return cached.items
  }

  const controller = new AbortController()
  const abortFromRefresh = () => controller.abort()
  if (refreshSignal?.aborted) controller.abort()
  else refreshSignal?.addEventListener('abort', abortFromRefresh, { once: true })
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(YUWEIWAN_URL, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return cached?.items ?? []
    const data = (await res.json()) as unknown
    const items = parseYuweiwanItems(data)
    if (items.length > 0) {
      g.__ywSourceCache = { items, fetchedAt: Date.now() }
      return items
    }
    return cached?.items ?? []
  } catch {
    return cached?.items ?? []
  } finally {
    clearTimeout(timer)
    refreshSignal?.removeEventListener('abort', abortFromRefresh)
  }
}
