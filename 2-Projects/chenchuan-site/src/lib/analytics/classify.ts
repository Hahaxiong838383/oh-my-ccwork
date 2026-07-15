export const TRAFFIC_KINDS = ['human', 'owner', 'aiops', 'prefetch', 'bot', 'legacy'] as const

export type TrafficKind = (typeof TRAFFIC_KINDS)[number]
export type TrackSource = 'client' | 'middleware' | 'legacy'

export interface TrafficClassification {
  kind: Exclude<TrafficKind, 'legacy'>
  reason: string
}

export interface TrafficSignal {
  path: string
  ip: string
  ua: string | null
  source: TrackSource
  isAdminSession?: boolean
  prefetchReason?: string | null
}

export interface TrafficClassifierConfig {
  ownerIps: ReadonlySet<string>
  aiopsIps: ReadonlySet<string>
}

const PUBLIC_PAGE_PATTERNS = [
  /^\/$/,
  /^\/(?:about|contact|patents|radar|videos|work|writing)\/?$/,
  /^\/work\/[^/]+\/?$/,
  /^\/writing\/[^/]+\/?$/,
  /^\/lab\/ar-hud-demo\/?$/,
  /^\/ai-os\/chat\/?$/,
  /^\/kidshub-ai(?:\/.*)?$/,
]

const STATIC_ASSET_PATTERN = /\.(?:avif|css|gif|ico|jpe?g|js|json|map|mp3|mp4|ogg|pdf|png|svg|txt|webm|webp|woff2?|xml)$/i
const AIOPS_UA_PATTERN = /(?:AI-Ops-Cockpit|Uptime-Kuma|kuma-monitor|site-health|healthcheck)/i
const BOT_UA_PATTERN = /(?:bot\b|spider|crawler|HeadlessChrome|zgrab|masscan|nmap|curl\/|wget\/|Go-http-client|python-requests|python-urllib|libwww-perl|Scrapy|PostmanRuntime|okhttp|Apache-HttpClient|node-fetch|axios\/)/i
const BROWSER_UA_PATTERN = /Mozilla\/5\.0.*(?:Chrome|Chromium|CriOS|Safari|Firefox|FxiOS|Edg|OPR|MicroMessenger)/i

function normalizeIp(ip: string): string {
  const trimmed = ip.trim()
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed
}

export function parseIpList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(/[\s,]+/)
      .map(normalizeIp)
      .filter(Boolean),
  )
}

export function getTrafficClassifierConfig(): TrafficClassifierConfig {
  return {
    ownerIps: parseIpList(process.env.ANALYTICS_OWNER_IPS),
    aiopsIps: parseIpList(process.env.ANALYTICS_AIOPS_IPS),
  }
}

export function isPublicPagePath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0] || '/'
  return PUBLIC_PAGE_PATTERNS.some((pattern) => pattern.test(pathname))
}

export function isStaticAssetPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0] || '/'
  return (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/media/') ||
    pathname.startsWith('/media-optimized/') ||
    pathname.startsWith('/media-posters/') ||
    STATIC_ASSET_PATTERN.test(pathname)
  )
}

export function isBrowserUserAgent(ua: string | null): boolean {
  return Boolean(ua && BROWSER_UA_PATTERN.test(ua) && !BOT_UA_PATTERN.test(ua))
}

export function getPrefetchReason(headers: Pick<Headers, 'get'>): string | null {
  if (headers.get('next-router-prefetch') !== null) return 'next_router_prefetch'
  if (headers.get('x-middleware-prefetch') !== null) return 'middleware_prefetch'

  const purpose = `${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''}`
  return /prefetch/i.test(purpose) ? 'browser_prefetch' : null
}

export function classifyTraffic(
  signal: TrafficSignal,
  config: TrafficClassifierConfig = getTrafficClassifierConfig(),
): TrafficClassification {
  const ip = normalizeIp(signal.ip)
  const ua = signal.ua?.trim() || null

  if (signal.prefetchReason) {
    return { kind: 'prefetch', reason: signal.prefetchReason }
  }
  if ((ua && AIOPS_UA_PATTERN.test(ua)) || config.aiopsIps.has(ip)) {
    return {
      kind: 'aiops',
      reason: ua && AIOPS_UA_PATTERN.test(ua) ? 'aiops_user_agent' : 'aiops_ip',
    }
  }
  if (signal.isAdminSession || config.ownerIps.has(ip)) {
    return {
      kind: 'owner',
      reason: signal.isAdminSession ? 'owner_admin_session' : 'owner_ip',
    }
  }
  if (!isPublicPagePath(signal.path)) {
    return { kind: 'bot', reason: 'invalid_page_path' }
  }
  if (!ua) {
    return { kind: 'bot', reason: 'empty_user_agent' }
  }
  if (BOT_UA_PATTERN.test(ua)) {
    return { kind: 'bot', reason: 'known_bot_user_agent' }
  }
  if (!isBrowserUserAgent(ua)) {
    return { kind: 'bot', reason: 'non_browser_client' }
  }

  return {
    kind: 'human',
    reason: signal.source === 'client' ? 'browser_hydrated' : 'legacy_browser_request',
  }
}
