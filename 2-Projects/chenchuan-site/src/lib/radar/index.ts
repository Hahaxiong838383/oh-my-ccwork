// AI 前沿资讯雷达 —— 聚合入口
//
// feed 架构（2026-07-02 治本改造，背景见 04-决策记录）：
// - stale-while-revalidate：有缓存（内存或盘）永远立即返回，过期只触发后台刷新，
//   请求路径不再阻塞等上游 —— 消灭「首访卡 40s」。
// - 磁盘持久化 data/radar-feed-cache.json：pm2 重启 / 部署后仍有数据（rsync 排除 /data 不会覆盖）。
// - 热冷分层（2026-07-08）：前 HOT_CAP(5000) 进热层（页面展示，radar-feed-cache.json），
//   被 cap 挤出的旧记录 append 冷层 data/radar-archive-cold/YYYY-MM.jsonl（只增不删=数据主权，每日异地备份香港）。
// - 失败负缓存 + 条数暴跌保护：上游抖动（字节US节点↔阿里KR路由黑洞）时不清空、不覆盖、发飞书告警。
import { promises as fs } from 'fs'
import path from 'path'
import { fetchAihotAll, fetchAihotLatest } from './aihot'
import { fetchYuweiwanLatest } from './yuweiwan'
import {
  dedupe,
  groupByMonth,
  HOT_CAP,
  isDegraded,
  parseDiskCacheRaw,
  sortByTimeDesc,
  splitHotCold,
} from './feed-cache'
import { sendChatAlert } from '@/lib/chat/feishu-alert'
import { RADAR_SEED } from '@/data/radar-seed'
import { RADAR_ARCHIVE } from '@/data/radar-archive'
import type { GithubRadarReport, RadarFeed, RadarItem, TheoryReport } from './types'

export * from './types'

const parsedFeedCacheTtl = Number(process.env.RADAR_FEED_CACHE_TTL_SECONDS || '300')
const RADAR_FEED_CACHE_TTL_MS =
  (Number.isFinite(parsedFeedCacheTtl) ? Math.max(60, parsedFeedCacheTtl) : 300) * 1000
const NEGATIVE_CACHE_MS = 90 * 1000 // 刷新失败后的静默窗：期间不再打上游，直接供旧数据
const REFRESH_TIMEOUT_MS = 90 * 1000

// 注意：放 data/ 根，不能进 data/radar/（那里是 theory 报告目录，readdir 按 *.json 全扫）
const FEED_CACHE_FILE = path.join(process.cwd(), 'data', 'radar-feed-cache.json')
const SOURCE_HEALTH_FILE = path.join(process.cwd(), 'data', 'radar-source-health.json')

// 冷层：被热层 cap 挤出的旧记录归档目录（按月 JSONL，只增不删 = 真正的「数据主权」）。
// rsync 部署排除 /data，运行时写入不被覆盖；每日 cron 异地备份到香港机。
const COLD_ARCHIVE_DIR =
  process.env.RADAR_COLD_DIR || path.join(process.cwd(), 'data', 'radar-archive-cold')

// 把被挤出热层的记录按月 append 到冷层 JSONL。fail-soft：冷层写失败绝不影响主链路/页面。
async function appendColdArchive(items: RadarItem[]): Promise<void> {
  if (items.length === 0) return
  try {
    await fs.mkdir(COLD_ARCHIVE_DIR, { recursive: true })
    const byMonth = groupByMonth(items)
    for (const [month, list] of Object.entries(byMonth)) {
      const lines = list.map((it) => JSON.stringify(it)).join('\n') + '\n'
      await fs.appendFile(path.join(COLD_ARCHIVE_DIR, `${month}.jsonl`), lines, 'utf-8')
    }
  } catch {
    // 存档失败不阻断（下轮被挤出的记录会再次尝试；冷层是备份非关键路径）
  }
}

type RadarFeedCache = {
  feed: RadarFeed
  cachedAt: number
}

const globalRadarFeed = globalThis as typeof globalThis & {
  __radarFeedCache?: RadarFeedCache
  __radarFeedRefresh?: Promise<RadarFeed>
  __radarFeedRefreshStartedAt?: number
  __radarFeedRefreshGeneration?: number
  __radarFeedNegativeUntil?: number
  __radarFeedDiskLoaded?: boolean
  __radarAlertLastSent?: number
}

// 告警冷却：上游持续异常时（负缓存 90s + TTL 5min 的组合下）每轮刷新失败都会走到告警分支，
// 不加冷却 = 上游挂 1 小时轰十几条重复消息。冷却窗口内只记升级状态、不重复发。
const ALERT_COOLDOWN_MS = 30 * 60 * 1000

async function loadDiskCache(): Promise<RadarFeedCache | null> {
  try {
    const raw = await fs.readFile(FEED_CACHE_FILE, 'utf-8')
    const parsed = parseDiskCacheRaw(raw)
    if (!parsed) return null
    return {
      feed: {
        items: parsed.items,
        fetchedAt: parsed.fetchedAt,
        ok: true,
        sourceCount: new Set(parsed.items.map((i) => i.source)).size,
      },
      cachedAt: parsed.cachedAt,
    }
  } catch {
    return null
  }
}

async function saveDiskCache(cache: RadarFeedCache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(FEED_CACHE_FILE), { recursive: true })
    const tmp = `${FEED_CACHE_FILE}.tmp`
    await fs.writeFile(
      tmp,
      JSON.stringify({
        cachedAt: cache.cachedAt,
        fetchedAt: cache.feed.fetchedAt,
        items: cache.feed.items,
      }),
      'utf-8',
    )
    await fs.rename(tmp, FEED_CACHE_FILE) // 原子替换，读端不会看到半截文件
  } catch {
    // 写盘失败不影响线上服务（下轮重试）
  }
}

type SourceHealthEntry = {
  ok: boolean
  count: number
  lastSuccessAt: string | null
  error: string | null
}

type SourceHealth = {
  checkedAt: string
  aihot: SourceHealthEntry
  yuweiwan: SourceHealthEntry
}

async function saveSourceHealth(
  checkedAt: string,
  aihotItems: RadarItem[],
  ywItems: RadarItem[],
  aihotRejected: boolean,
  ywRejected: boolean,
): Promise<void> {
  let previous: Partial<SourceHealth> = {}
  try {
    previous = JSON.parse(await fs.readFile(SOURCE_HEALTH_FILE, 'utf-8')) as SourceHealth
  } catch {
    // 首次运行没有历史状态。
  }

  const entry = (
    items: RadarItem[],
    rejected: boolean,
    prev: SourceHealthEntry | undefined,
  ): SourceHealthEntry => ({
    ok: items.length > 0 && !rejected,
    count: items.length,
    lastSuccessAt: items.length > 0 && !rejected ? checkedAt : prev?.lastSuccessAt ?? null,
    error: rejected ? 'request_rejected' : items.length === 0 ? 'zero_items' : null,
  })

  const health: SourceHealth = {
    checkedAt,
    aihot: entry(aihotItems, aihotRejected, previous.aihot),
    yuweiwan: entry(ywItems, ywRejected, previous.yuweiwan),
  }

  try {
    const tmp = `${SOURCE_HEALTH_FILE}.tmp`
    await fs.writeFile(tmp, JSON.stringify(health, null, 2), 'utf-8')
    await fs.rename(tmp, SOURCE_HEALTH_FILE)
  } catch {
    // 可观测文件写入失败不阻断资讯主链路。
  }
}

// 双上游并行（2026-07-07 起）：aihot（主，泛 AI 资讯 ~1900 条）+ yuweiwan（副，92 源中文聚合 ~770 条）。
// allSettled 隔离故障——任一源挂只少一路数据，绝不拖垮另一路；归档合并天然按 url 去重叠。
async function refreshRadarFeed(
  prev: RadarFeedCache | undefined,
  signal?: AbortSignal,
  generation?: number,
): Promise<RadarFeed> {
  const [aihotSettled, ywSettled] = await Promise.allSettled([
    fetchAihotAll(1000, 'no-store', signal),
    fetchYuweiwanLatest(signal),
  ])
  if (signal?.aborted || generation !== globalRadarFeed.__radarFeedRefreshGeneration) {
    throw new Error('radar_refresh_superseded')
  }
  const aihotItems = aihotSettled.status === 'fulfilled' ? aihotSettled.value : []
  const ywItems = ywSettled.status === 'fulfilled' ? ywSettled.value : []
  const freshItems = sortByTimeDesc(dedupe([...aihotItems, ...ywItems]))
  const prevItems = prev?.feed.items ?? []
  const now = Date.now()
  const checkedAt = new Date(now).toISOString()

  void saveSourceHealth(
    checkedAt,
    aihotItems,
    ywItems,
    aihotSettled.status === 'rejected',
    ywSettled.status === 'rejected',
  )

  const failed = freshItems.length === 0
  const degraded = isDegraded(freshItems.length, prevItems.length)

  const maybeAlert = (title: string, summary: string) => {
    const lastSent = globalRadarFeed.__radarAlertLastSent ?? 0
    if (now - lastSent <= ALERT_COOLDOWN_MS) return
    globalRadarFeed.__radarAlertLastSent = now
    void sendChatAlert({
      type: 'radar_degraded',
      title,
      summary,
      fields: {
        'aihot(主源)': `${aihotItems.length} 条`,
        'yuweiwan(副源)': `${ywItems.length} 条`,
        本地归档: `${prevItems.length} 条`,
        服务器: 'aliyun-kr（韩国）',
        冷却: '同类告警 30 分钟内不重复',
      },
    })
  }

  if (failed) {
    globalRadarFeed.__radarFeedNegativeUntil = now + NEGATIVE_CACHE_MS
    maybeAlert(
      '📡 雷达资讯流：双上游全部拉取失败',
      '本轮 aihot 与 yuweiwan 均 0 条，已自动回退服务器本地归档，**页面用户无感，无需操作**。若持续告警：检查网络出口 / hosts 钉的节点 / GitHub raw 可达性。',
    )
    if (prev) return prev.feed
    return { items: [], fetchedAt: new Date().toISOString(), ok: false, sourceCount: 0 }
  }

  // 部分成功（条数暴跌）：与全失败不同——新内容仍要吸收进归档（并集不缩水），
  // 但发告警提示某路源可能出问题（分源计数直接可见是哪路）。
  if (degraded) {
    maybeAlert(
      '📡 雷达资讯流：拉取降级（部分源疑似失败）',
      `本轮合计 ${freshItems.length} 条，较归档 ${prevItems.length} 条暴跌。新内容已照常并入归档（并集不缩水），**页面用户无感**。持续出现再按分源计数排查。`,
    )
  }

  // 热冷分层：前 hotCap 进热层（页面展示），被挤出的旧记录归档到冷层 JSONL（不再永久丢弃）。
  // hotCap 支持 env 覆盖（RADAR_HOT_CAP），便于运维调整展示容量而不改代码。
  const hotCap = Number(process.env.RADAR_HOT_CAP) || HOT_CAP
  const { hot, evicted } = splitHotCold(freshItems, prevItems, hotCap)
  void appendColdArchive(evicted)
  const feed: RadarFeed = {
    items: hot,
    fetchedAt: new Date().toISOString(),
    ok: true,
    sourceCount: new Set(hot.map((i) => i.source)).size,
  }
  const cache: RadarFeedCache = { feed, cachedAt: now }
  globalRadarFeed.__radarFeedCache = cache
  void saveDiskCache(cache)
  return feed
}

// 聚合一轮资讯：stale-while-revalidate。
// - 缓存新鲜 → 直接回
// - 缓存过期 → 立即回旧数据，后台刷新（in-flight 去重；负缓存窗内不重试）
// - 完全无缓存（首次冷启且盘为空）→ 唯一需要阻塞等待的场景
export async function getRadarFeed(): Promise<RadarFeed> {
  const g = globalRadarFeed

  if (!g.__radarFeedCache && !g.__radarFeedDiskLoaded) {
    g.__radarFeedDiskLoaded = true
    const disk = await loadDiskCache()
    if (disk) g.__radarFeedCache = disk
  }

  const cached = g.__radarFeedCache
  const now = Date.now()

  if (cached && now - cached.cachedAt < RADAR_FEED_CACHE_TTL_MS) {
    return cached.feed
  }
  if (cached && now < (g.__radarFeedNegativeUntil ?? 0)) {
    return cached.feed
  }

  const refreshAge = now - (g.__radarFeedRefreshStartedAt ?? now)
  if (g.__radarFeedRefresh && refreshAge > REFRESH_TIMEOUT_MS) {
    console.warn('[radar] stale refresh lock released', { refreshAgeMs: refreshAge })
    g.__radarFeedRefreshGeneration = (g.__radarFeedRefreshGeneration ?? 0) + 1
    g.__radarFeedRefresh = undefined
    g.__radarFeedRefreshStartedAt = undefined
  }

  if (!g.__radarFeedRefresh) {
    const generation = (g.__radarFeedRefreshGeneration ?? 0) + 1
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    g.__radarFeedRefreshGeneration = generation
    g.__radarFeedRefreshStartedAt = now

    const refresh = Promise.race([
      refreshRadarFeed(cached, controller.signal, generation),
      new Promise<RadarFeed>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          if (g.__radarFeedRefreshGeneration === generation) {
            g.__radarFeedRefreshGeneration = generation + 1
          }
          reject(new Error('radar_refresh_timeout'))
        }, REFRESH_TIMEOUT_MS)
      }),
    ])
      .catch((): RadarFeed => {
        // refreshRadarFeed 内部已 fail-soft，这里兜底意外异常：供旧或空，绝不向页面抛错
        globalRadarFeed.__radarFeedNegativeUntil = Date.now() + NEGATIVE_CACHE_MS
        return (
          cached?.feed ?? {
            items: [],
            fetchedAt: new Date().toISOString(),
            ok: false,
            sourceCount: 0,
          }
        )
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout)
        if (g.__radarFeedRefresh === refresh) {
          g.__radarFeedRefresh = undefined
          g.__radarFeedRefreshStartedAt = undefined
        }
      })
    g.__radarFeedRefresh = refresh
  }

  if (cached) {
    return cached.feed // SWR：旧数据立即返回，刷新在后台完成
  }
  return g.__radarFeedRefresh
}

// 首页 Hero 滚动条用：最新混合资讯（去重）
function getTheoryTickerFallback(take: number): RadarItem[] {
  const reports = sortReportsDesc([RADAR_SEED, ...RADAR_ARCHIVE])
  const items = reports.flatMap((report) =>
    report.papers.map((paper) => ({
      id: `theory:${report.date}:${paper.arxivId || paper.index}:${paper.url}`,
      title: paper.title,
      url: paper.url,
      source: paper.arxivId ? `arXiv ${paper.arxivId}` : 'theory-radar',
      publishedAt: paper.published
        ? `${paper.published}T00:00:00Z`
        : `${report.date}T00:00:00+08:00`,
      summary: paper.finding ?? report.summary ?? null,
      category: 'paper' as const,
    })),
  )
  return sortByTimeDesc(dedupe(items)).slice(0, take)
}

export async function getRadarTicker(take = 14): Promise<RadarItem[]> {
  const latest = dedupe(await fetchAihotLatest(take))
  if (latest.length > 0) return latest

  const cachedFeed = globalRadarFeed.__radarFeedCache?.feed
  if (cachedFeed?.items.length) {
    return sortByTimeDesc(cachedFeed.items).slice(0, take)
  }

  const disk = await loadDiskCache()
  if (disk?.feed.items.length) {
    globalRadarFeed.__radarFeedCache = disk
    return sortByTimeDesc(disk.feed.items).slice(0, take)
  }

  return getTheoryTickerFallback(take)
}

// theory-radar agent 推送的深度报告落盘目录
// 注意：rsync 部署排除 /data/，所以运行时写入不会被覆盖；目录不存在时优雅返回 null
const RADAR_DATA_DIR =
  process.env.RADAR_DATA_DIR || path.join(process.cwd(), 'data', 'radar')

function reportSortTime(report: TheoryReport): number {
  const dateTime = Date.parse(report.date)
  if (!Number.isNaN(dateTime)) return dateTime
  const generatedTime = Date.parse(report.generatedAt)
  return Number.isNaN(generatedTime) ? 0 : generatedTime
}

function sortReportsDesc(reports: TheoryReport[]): TheoryReport[] {
  return [...reports].sort((a, b) => reportSortTime(b) - reportSortTime(a))
}

function isValidTheoryReport(report: unknown): report is TheoryReport {
  if (!report || typeof report !== 'object') return false
  const r = report as Partial<TheoryReport>
  return typeof r.date === 'string' && Array.isArray(r.papers) && r.papers.length > 0
}

async function getRuntimeTheoryReports(): Promise<TheoryReport[]> {
  try {
    const files = await fs.readdir(RADAR_DATA_DIR)
    const reports = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (file) => {
          try {
            const raw = await fs.readFile(path.join(RADAR_DATA_DIR, file), 'utf-8')
            const parsed = JSON.parse(raw) as unknown
            return isValidTheoryReport(parsed) ? parsed : null
          } catch {
            return null
          }
        }),
    )
    return sortReportsDesc(reports.filter((r): r is TheoryReport => Boolean(r)))
  } catch {
    return []
  }
}

// 深度拆解多期列表：运行时 webhook 全量归档 + seed + 历史归档（一次性导入），按日期倒序去重
// 去重 key = date + 是否专家专题（同日的常规期与专家专题并存）
export async function getTheoryReports(): Promise<TheoryReport[]> {
  const runtimeReports = await getRuntimeTheoryReports()
  const out: TheoryReport[] = []
  const seen = new Set<string>()
  const keyOf = (r: TheoryReport) =>
    `${r.date}:${(r.summary || '').includes('专家追踪专题') ? 'e' : 'n'}`
  const push = (r: TheoryReport | null) => {
    if (!r) return
    const k = keyOf(r)
    if (seen.has(k)) return
    seen.add(k)
    out.push(r)
  }
  for (const r of runtimeReports) push(r)
  push(RADAR_SEED)
  for (const r of sortReportsDesc(RADAR_ARCHIVE)) push(r)
  return out
}

// 优先读 webhook 推送的实时报告（/data/radar）；没有则回落到种子（页面永不空）
export async function getLatestTheoryReport(): Promise<TheoryReport | null> {
  const reports = await getRuntimeTheoryReports()
  return reports[0] ?? RADAR_SEED
}

// ── GitHub 风向标（github-radar agent 推送，data/radar-github/report-*.json） ──
const GITHUB_RADAR_DIR =
  process.env.RADAR_GITHUB_DATA_DIR || path.join(process.cwd(), 'data', 'radar-github')

function isValidGithubReport(r: unknown): r is GithubRadarReport {
  if (!r || typeof r !== 'object') return false
  const g = r as Partial<GithubRadarReport>
  return (
    typeof g.date === 'string' &&
    Array.isArray(g.categories) &&
    g.categories.some((c) => c && Array.isArray(c.repos) && c.repos.length > 0)
  )
}

// 读最新一期 GitHub 风向标；无数据/脏数据返回 null（页面隐藏板块，优雅缺省）
export async function getLatestGithubRadar(): Promise<GithubRadarReport | null> {
  try {
    const files = (await fs.readdir(GITHUB_RADAR_DIR))
      .filter((f) => /^report-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
    const latest = files[files.length - 1]
    if (!latest) return null
    const raw = await fs.readFile(path.join(GITHUB_RADAR_DIR, latest), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    return isValidGithubReport(parsed) ? parsed : null
  } catch {
    return null
  }
}
