// aihot.virxact.com 公开 API 适配器
// 契约（2026-06-14 实测验证）：
//   GET /api/public/items?mode=all&category=<cat>&take=<n>
//   必带浏览器 User-Agent（curl/* UA 会被 nginx 黑名单 403），无需鉴权，限速 600 req/min/IP
//   响应：{ count, hasNext, nextCursor, items:[{id,title,title_en,url,source,publishedAt,summary,category}] }

import type { RadarCategory, RadarItem } from './types'
import { CATEGORY_ORDER } from './types'

const AIHOT_BASE = 'https://aihot.virxact.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

interface AihotRaw {
  id?: string
  title?: string
  title_en?: string | null
  url?: string
  source?: string
  publishedAt?: string | null
  summary?: string | null
  category?: string | null
}

interface AihotPage {
  items: RadarItem[]
  hasNext: boolean
  nextCursor: string | null
}

type AihotCacheMode = 'next-revalidate' | 'no-store'

const PAGE_TIMEOUT_MS = 6000 // 健康节点 0.2-0.9s；6s 给火山CN节点偶发抖动(2-4s)留余量，避免误丢页(2026-07-08 从 4s 放宽)
const PAGE_RETRY = 1 // 单页失败(含超时)重试次数——瞬时抖动一次机会，治 aihot 412 类暴跌
const FAILURE_LOG_COOLDOWN_MS = 5 * 60 * 1000

const globalAihot = globalThis as typeof globalThis & {
  __aihotFailureLogAt?: Record<string, number>
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause as { code?: string; message?: string } | undefined
  return [error.name, error.message, cause?.code, cause?.message].filter(Boolean).join(': ')
}

function logFinalFailure(key: string, context: Record<string, unknown>, error: unknown): void {
  const now = Date.now()
  const loggedAt = globalAihot.__aihotFailureLogAt ?? {}
  if (now - (loggedAt[key] ?? 0) < FAILURE_LOG_COOLDOWN_MS) return
  loggedAt[key] = now
  globalAihot.__aihotFailureLogAt = loggedAt
  console.warn('[radar:aihot] fetch failed after retry', {
    ...context,
    error: describeError(error),
  })
}

// 拉单页（take 硬上限 100；cursor 为空=第一页）。返回 items + 分页信息。失败重试 PAGE_RETRY 次。
async function fetchPage(
  category: RadarCategory,
  cursor: string | null,
  cacheMode: AihotCacheMode = 'next-revalidate',
  attempt = 0,
): Promise<AihotPage> {
  const params = new URLSearchParams({ mode: 'all', category, take: '100' })
  if (cursor) params.set('cursor', cursor)
  const url = `${AIHOT_BASE}/api/public/items?${params.toString()}`
  // Node fetch 无默认超时；源站挂起会拖死 ISR 再生/构建，用 AbortController 兜底
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `${AIHOT_BASE}/`,
      },
      signal: controller.signal,
      ...(cacheMode === 'no-store'
        ? { cache: 'no-store' as const }
        : {
            // 首页 ticker 继续用 Next Data Cache；/radar 全量流走 src/lib/radar/index.ts 的阻塞式缓存。
            next: { revalidate: 900 },
          }),
    })
    if (!res.ok) throw new Error(`http_${res.status}`)
    const data = (await res.json()) as {
      items?: AihotRaw[]
      hasNext?: boolean
      nextCursor?: string | null
    }
    const raw = Array.isArray(data.items) ? data.items : []
    const items = raw
      .filter((it): it is AihotRaw & { id: string; title: string; url: string } =>
        Boolean(it && it.id && it.title && it.url),
      )
      .map((it) => ({
        id: it.id,
        title: it.title,
        titleEn: it.title_en ?? null,
        url: it.url,
        source: it.source || '未知来源',
        publishedAt: it.publishedAt ?? null,
        summary: it.summary ?? null,
        category: (isCategory(it.category) ? it.category : category) as RadarCategory,
      }))
    return { items, hasNext: Boolean(data.hasNext), nextCursor: data.nextCursor ?? null }
  } catch (error) {
    // 单页失败（含超时 abort / !ok）：重试一次给瞬时抖动机会，仍失败则 fail-soft 返回空（不影响其余页）
    if (attempt < PAGE_RETRY) return fetchPage(category, cursor, cacheMode, attempt + 1)
    logFinalFailure(
      `page:${category}:${cursor ? 'cursor' : 'first'}`,
      { category, page: cursor ? 'cursor' : 'first', attempts: attempt + 1 },
      error,
    )
    return { items: [], hasNext: false, nextCursor: null }
  } finally {
    clearTimeout(timer)
  }
}

// 分页拉全一个分类：cursor 翻页到 hasNext=false。cap 防失控（API take 上限 100/页）。
// 实测各类总量：models~140 / products~413 / industry~567 / paper~144 / tip~674（2026-06-15）。
// cap=1000（10 页）覆盖最大类 tip + 增长 buffer，正常拉到 hasNext=false 即停。
async function fetchCategoryPaged(
  category: RadarCategory,
  cap = 1000,
  cacheMode: AihotCacheMode = 'next-revalidate',
): Promise<RadarItem[]> {
  const out: RadarItem[] = []
  let cursor: string | null = null
  for (let page = 0; page < 10; page++) {
    const { items, hasNext, nextCursor } = await fetchPage(category, cursor, cacheMode)
    out.push(...items)
    if (!hasNext || !nextCursor || out.length >= cap) break
    cursor = nextCursor
  }
  return out.slice(0, cap)
}

function isCategory(v: unknown): v is RadarCategory {
  return typeof v === 'string' && (CATEGORY_ORDER as string[]).includes(v)
}

// 并行拉取全部分类（类内仍串行翻页）：全量刷新耗时 ≈ 最慢一类而非五类之和。
// 并发峰值 5 req，总量 25~30 次/轮，距限速 600/min 很远。Promise.all 保序（按 CATEGORY_ORDER）。
export async function fetchAihotAll(
  capPerCat = 1000,
  cacheMode: AihotCacheMode = 'next-revalidate',
): Promise<RadarItem[]> {
  const perCategory = await Promise.all(
    CATEGORY_ORDER.map((category) => fetchCategoryPaged(category, capPerCat, cacheMode)),
  )
  return perCategory.flat()
}

// 首页 ticker 专用：单次调用拿最新混合资讯（不分类，轻量，给首页 Hero 滚动条用）
export async function fetchAihotLatest(take = 14): Promise<RadarItem[]> {
  const url = `${AIHOT_BASE}/api/public/items?mode=all&take=${take}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `${AIHOT_BASE}/`,
      },
      signal: controller.signal,
      next: { revalidate: 900 },
    })
    if (!res.ok) return []
    const data = (await res.json()) as { items?: AihotRaw[] }
    const items = Array.isArray(data.items) ? data.items : []
    return items
      .filter((it): it is AihotRaw & { id: string; title: string; url: string } =>
        Boolean(it && it.id && it.title && it.url),
      )
      .map((it) => ({
        id: it.id,
        title: it.title,
        titleEn: it.title_en ?? null,
        url: it.url,
        source: it.source || '未知来源',
        publishedAt: it.publishedAt ?? null,
        summary: it.summary ?? null,
        category: (isCategory(it.category) ? it.category : null) as RadarCategory | null,
      }))
  } catch (error) {
    logFinalFailure('latest', { endpoint: 'latest', attempts: 1 }, error)
    return []
  } finally {
    clearTimeout(timer)
  }
}
