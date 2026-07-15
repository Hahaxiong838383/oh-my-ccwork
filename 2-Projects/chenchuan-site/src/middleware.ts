import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import {
  classifyTraffic,
  getPrefetchReason,
  isBrowserUserAgent,
  isPublicPagePath,
  isStaticAssetPath,
} from '@/lib/analytics/classify'

// 真人访问由浏览器 hydration 后的 AnalyticsTracker 上报，避免 Next.js prefetch
// 和不会执行 JS 的探针/扫描器污染主统计。middleware 只记录系统类流量。

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|media).*)',
  ],
}

const TRACK_METHODS = new Set(['GET'])

export async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname

  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value
    const claims = sessionCookie ? await verifySession(sessionCookie) : null
    if (!claims) {
      const loginUrl = new URL('/admin/login', request.url)
      return NextResponse.redirect(loginUrl)
    }
    return NextResponse.next()
  }

  if (!TRACK_METHODS.has(request.method)) return NextResponse.next()
  if (
    pathname.startsWith('/admin') ||
    pathname.startsWith('/.well-known') ||
    isStaticAssetPath(pathname)
  ) {
    return NextResponse.next()
  }

  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  const country = request.headers.get('cf-ipcountry')
  const referrer = request.headers.get('referer')
  const ua = request.headers.get('user-agent')
  const prefetchReason = getPrefetchReason(request.headers)
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value
  const isAdminSession = Boolean(sessionCookie && (await verifySession(sessionCookie)))
  const classification = classifyTraffic({
    path: pathname,
    ip,
    ua,
    source: 'middleware',
    isAdminSession,
    prefetchReason,
  })

  // 正常浏览器和站长浏览器统一交给 hydration tracker，只记一次真实页面浏览。
  if (
    classification.kind === 'human' ||
    (classification.kind === 'owner' && isBrowserUserAgent(ua) && isPublicPagePath(pathname))
  ) {
    return NextResponse.next()
  }

  const internalHost = process.env.ANALYTICS_INTERNAL_HOST ?? '127.0.0.1:3000'
  const trackUrl = `http://${internalHost}/api/track`
  const internalToken = process.env.ANALYTICS_INTERNAL_TOKEN ?? 'dev-analytics-internal'

  const trackPromise = fetch(trackUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-analytics-internal-token': internalToken,
    },
    body: JSON.stringify({
      source: 'middleware',
      path: pathname,
      referrer,
      ip,
      ua,
      country,
      isAdminSession,
      prefetchReason,
    }),
  }).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      '[analytics-middleware] track failed:',
      err instanceof Error ? err.message : String(err),
    )
  })

  event.waitUntil(trackPromise)
  return NextResponse.next()
}
