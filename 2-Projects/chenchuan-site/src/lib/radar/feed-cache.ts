// radar feed 持久缓存的纯函数层（无 server-only / fs 依赖，可单测）
// index.ts 负责 IO（读写盘 / 内存缓存 / 告警），本文件只做数据变换与判定。
import type { RadarItem } from './types'

export const ARCHIVE_CAP = 3000 // 兼容保留（mergeArchive 默认值）
export const HOT_CAP = 5000 // 热层：进页面展示的最新 N 条（2026-07-08 分层改造）
export const DEGRADE_RATIO = 0.5
export const DEGRADE_MIN_BASE = 200

// 按 id 主键去重（id 即 React render key），同时丢弃重复 url 的回流
export function dedupe(items: RadarItem[]): RadarItem[] {
  const seenId = new Set<string>()
  const seenUrl = new Set<string>()
  const out: RadarItem[] = []
  for (const it of items) {
    if (seenId.has(it.id)) continue
    if (it.url && seenUrl.has(it.url)) continue
    seenId.add(it.id)
    if (it.url) seenUrl.add(it.url)
    out.push(it)
  }
  return out
}

export function sortByTimeDesc(items: RadarItem[]): RadarItem[] {
  return [...items].sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
  })
}

// 归档合并：本轮新拉资讯 + 服务器留存的旧库（上游滚动淘汰后我们仍保留），
// 去重后时间倒序，cap 防无限膨胀。fresh 在前保证同 id 时新数据胜出。
export function mergeArchive(
  fresh: RadarItem[],
  prev: RadarItem[],
  cap = ARCHIVE_CAP,
): RadarItem[] {
  return sortByTimeDesc(dedupe([...fresh, ...prev])).slice(0, cap)
}

// 热冷分层（2026-07-08）：合并去重排序后，前 hotCap 进热层（展示），其余是被挤出的冷层增量。
// evicted 天然低重复——一条一旦被挤出热层，下轮 prev/fresh 都不再含它（除非上游重推），只会 append 一次。
export function splitHotCold(
  fresh: RadarItem[],
  prev: RadarItem[],
  hotCap = HOT_CAP,
): { hot: RadarItem[]; evicted: RadarItem[] } {
  const all = sortByTimeDesc(dedupe([...fresh, ...prev]))
  return { hot: all.slice(0, hotCap), evicted: all.slice(hotCap) }
}

// 冷层按 publishedAt 月份分文件（YYYY-MM.jsonl）；无有效日期归 'unknown'，不丢
export function monthKey(publishedAt: string | null): string {
  if (publishedAt) {
    const t = Date.parse(publishedAt)
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 7)
  }
  return 'unknown'
}

export function groupByMonth(items: RadarItem[]): Record<string, RadarItem[]> {
  const out: Record<string, RadarItem[]> = {}
  for (const it of items) {
    const m = monthKey(it.publishedAt)
    ;(out[m] ||= []).push(it)
  }
  return out
}

// 条数暴跌判定：旧归档已成规模（≥ minBase）而新拉结果不足其一半 → 视为上游部分失败，
// 不能拿残缺结果覆盖归档（修 2026-07-02 实测到的 1929→100 降级覆盖问题）。
export function isDegraded(
  freshCount: number,
  prevCount: number,
  ratio = DEGRADE_RATIO,
  minBase = DEGRADE_MIN_BASE,
): boolean {
  return prevCount >= minBase && freshCount < prevCount * ratio
}

export interface ParsedDiskCache {
  items: RadarItem[]
  fetchedAt: string
  cachedAt: number
}

function isRadarItemLike(it: unknown): it is RadarItem {
  if (!it || typeof it !== 'object') return false
  const r = it as Partial<RadarItem>
  return (
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.title === 'string' && r.title.length > 0 &&
    typeof r.url === 'string' && r.url.length > 0
  )
}

// 盘缓存解析 + schema 过滤（系统边界：文件可能被截断/手改/版本不兼容，fail-soft 返回 null）
export function parseDiskCacheRaw(raw: string): ParsedDiskCache | null {
  try {
    const parsed = JSON.parse(raw) as {
      items?: unknown
      fetchedAt?: unknown
      cachedAt?: unknown
    }
    if (!Array.isArray(parsed.items)) return null
    const items = parsed.items.filter(isRadarItemLike)
    if (items.length === 0) return null
    return {
      items,
      fetchedAt:
        typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : new Date(0).toISOString(),
      // cachedAt 缺失/非法 → 0：数据可用但视为已过期，触发一次后台刷新
      cachedAt: typeof parsed.cachedAt === 'number' && Number.isFinite(parsed.cachedAt)
        ? parsed.cachedAt
        : 0,
    }
  } catch {
    return null
  }
}
