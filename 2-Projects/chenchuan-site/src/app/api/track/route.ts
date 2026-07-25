import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import { classifyTraffic, type TrackSource } from '@/lib/analytics/classify'
import { trackVisit } from '@/lib/analytics/track'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface TrackPayload {
  source?: unknown
  path?: unknown
  referrer?: unknown
  ip?: unknown
  ua?: unknown
  country?: unknown
  isAdminSession?: unknown
  prefetchReason?: unknown
}

function asString(v: unknown, fallback: string | null = null): string | null {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function requestIp(headers: Headers): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

function isTrackSource(value: unknown): value is Exclude<TrackSource, 'legacy'> {
  return value === 'client' || value === 'middleware'
}

// 浏览器 hydration 与内部 middleware 共用此入口。任何失败都返回 204，
// 统计链路永远不能影响主站可用性。
export async function POST(req: Request): Promise<Response> {
  try {
    const payload = (await req.json()) as TrackPayload
    if (!isTrackSource(payload.source)) return new NextResponse(null, { status: 204 })

    const path = asString(payload.path, '/') ?? '/'
    const referrer = asString(payload.referrer)
    let ip: string
    let ua: string | null
    let country: string | null
    let isAdminSession = false
    let prefetchReason: string | null = null

    if (payload.source === 'client') {
      ip = requestIp(req.headers)
      ua = req.headers.get('user-agent')
      country = req.headers.get('cf-ipcountry')
      const cookieStore = await cookies()
      const sessionToken = cookieStore.get(SESSION_COOKIE_NAME)?.value
      isAdminSession = Boolean(sessionToken && (await verifySession(sessionToken)))
    } else {
      const expectedToken =
        process.env.ANALYTICS_INTERNAL_TOKEN ??
        (process.env.NODE_ENV === 'production' ? null : 'dev-analytics-internal')
      const providedToken = req.headers.get('x-analytics-internal-token')
      if (!expectedToken || providedToken !== expectedToken) {
        return new NextResponse(null, { status: 204 })
      }

      ip = asString(payload.ip, 'unknown') ?? 'unknown'
      ua = asString(payload.ua)
      country = asString(payload.country)
      isAdminSession = payload.isAdminSession === true
      prefetchReason = asString(payload.prefetchReason)
    }

    const classification = classifyTraffic({
      path,
      ip,
      ua,
      source: payload.source,
      isAdminSession,
      prefetchReason,
    })

    trackVisit({ path, referrer, ip, ua, country, classification })
  } catch {
    // 静默吞错
  }
  return new NextResponse(null, { status: 204 })
}
