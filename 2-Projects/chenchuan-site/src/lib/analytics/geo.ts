import 'server-only'

// IP 归属地查询
// 数据源：ip-api.com batch endpoint（免费、不需 token、HTTP）
//   限制：单 IP 出网 45 req/min，单批 100 IP
// 缓存：进程内 Map（重启清空，TTL 24h）
// 容错：任何失败都返回空 GeoInfo，不影响 dashboard 渲染
// 隔离：仅 admin SSR 阶段调用，不进入 track 链路

export interface GeoInfo {
  country: string | null
  region: string | null
  city: string | null
  isp: string | null
  asn: string | null
}

interface CacheEntry {
  info: GeoInfo
  expiresAt: number
}

const EMPTY_GEO: GeoInfo = {
  country: null,
  region: null,
  city: null,
  isp: null,
  asn: null,
}

const cache = new Map<string, CacheEntry>()
const TTL_MS = 24 * 60 * 60 * 1000 // 24 小时
const API_URL = process.env.ANALYTICS_GEO_API ?? 'http://ip-api.com/batch'
const FIELDS = 'status,country,regionName,city,isp,as,query'
const BATCH_SIZE = 100
const FETCH_TIMEOUT_MS = 8000

// 私网 / 本地 / 无效 IP 跳过外网查询
function isPrivateOrInvalid(ip: string): boolean {
  if (!ip || ip === 'unknown') return true
  if (ip === '::1' || ip === '0.0.0.0') return true
  if (ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true
  // 172.16.0.0 - 172.31.255.255
  if (ip.startsWith('172.')) {
    const second = Number.parseInt(ip.split('.')[1] ?? '', 10)
    if (second >= 16 && second <= 31) return true
  }
  // IPv6 link-local / unique local
  if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true
  return false
}

interface ApiResp {
  status: string
  country?: string
  regionName?: string
  city?: string
  isp?: string
  as?: string
  query: string
}

function toGeoInfo(item: ApiResp): GeoInfo {
  if (item.status !== 'success') return EMPTY_GEO
  return {
    country: item.country ?? null,
    region: item.regionName ?? null,
    city: item.city ?? null,
    isp: item.isp ?? null,
    asn: item.as ?? null,
  }
}

// 批量查询 IP 归属地。返回 Map<ip, GeoInfo>，未命中的 IP 也会有 entry（值是 EMPTY_GEO）。
export async function lookupGeoBatch(ips: string[]): Promise<Map<string, GeoInfo>> {
  const result = new Map<string, GeoInfo>()
  const now = Date.now()
  const needFetch: string[] = []

  // 去重 + cache 命中 + 私网过滤
  const unique = Array.from(new Set(ips))
  for (const ip of unique) {
    if (isPrivateOrInvalid(ip)) {
      result.set(ip, EMPTY_GEO)
      continue
    }
    const cached = cache.get(ip)
    if (cached && cached.expiresAt > now) {
      result.set(ip, cached.info)
      continue
    }
    needFetch.push(ip)
  }

  if (needFetch.length === 0) return result

  // 分批调 API（单批最多 100）
  for (let i = 0; i < needFetch.length; i += BATCH_SIZE) {
    const chunk = needFetch.slice(i, i + BATCH_SIZE)
    try {
      const body = chunk.map((ip) => ({ query: ip, fields: FIELDS }))
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!resp.ok) continue
      const data = (await resp.json()) as ApiResp[]
      for (const item of data) {
        const info = toGeoInfo(item)
        result.set(item.query, info)
        cache.set(item.query, { info, expiresAt: now + TTL_MS })
      }
    } catch (err) {
      // 静默：geo 查询失败不影响 dashboard 渲染
      // eslint-disable-next-line no-console
      console.warn(
        '[analytics/geo] batch lookup failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // 没拿到的 IP 兜底
  for (const ip of needFetch) {
    if (!result.has(ip)) {
      result.set(ip, EMPTY_GEO)
    }
  }

  return result
}

// 把 GeoInfo 压成单行展示字符串："City, Region · ISP" 或 fallback "Country" 或 "—"
export function formatGeo(info: GeoInfo | undefined, fallbackCountry?: string | null): string {
  if (!info) return fallbackCountry ?? '—'
  const place = [info.city, info.region].filter(Boolean).join(', ')
  const parts: string[] = []
  if (place) parts.push(place)
  else if (info.country) parts.push(info.country)
  else if (fallbackCountry) parts.push(fallbackCountry)
  if (info.isp) parts.push(info.isp)
  return parts.length > 0 ? parts.join(' · ') : fallbackCountry ?? '—'
}
