import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'

// Edge runtime middleware：
// 1. 拦截页面访问，fire-and-forget 触发 /api/track 记录
// 2. 保护 /admin/* 路由（无 session 跳 /admin/login）
// 任何失败都不阻塞响应（waitUntil + catch 双保险，主站可用性永远 0 影响）

// 排除：静态资源 / Next 内部 / API 路由（防 /api/track 递归触发）/ media 文件
export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|media).*)',
  ],
}

// 只统计 GET 页面请求（POST/HEAD/等不计）
const TRACK_METHODS = new Set(['GET'])

export async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname

  // === /admin/* 路由保护 ===
  // /admin/login 自身放行；其他 /admin/* 需要有效 session，否则跳 /admin/login
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value
    const claims = sessionCookie ? await verifySession(sessionCookie) : null
    if (!claims) {
      const loginUrl = new URL('/admin/login', request.url)
      return NextResponse.redirect(loginUrl)
    }
    // 已登录：不记录访问统计（admin 自身浏览不污染数据），直接放行
    return NextResponse.next()
  }

  // 过滤非 GET + 防爬虫常见路径
  if (!TRACK_METHODS.has(request.method)) {
    return NextResponse.next()
  }

  // 排除 admin 后台自身访问（不污染统计）+ 探针路径
  if (
    pathname.startsWith('/admin') ||
    pathname.startsWith('/.well-known') ||
    pathname.endsWith('.map') ||
    pathname.endsWith('.txt')
  ) {
    return NextResponse.next()
  }

  // 提取 header（Cloudflare CDN 注入 cf-connecting-ip / cf-ipcountry）
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  const country = request.headers.get('cf-ipcountry')
  const referrer = request.headers.get('referer')
  const ua = request.headers.get('user-agent')

  // fire-and-forget POST /api/track。
  // 关键：用内部 127.0.0.1:PORT 而非 request.url（外网域名）— 否则 fetch 自己
  // 会走 Cloudflare CDN + nginx 回旋，失败率高（实测公网 middleware fetch 失败）。
  // 内部 fetch 直连 Next.js 自身进程，0 网络层 + 0 SSL 握手。
  const internalHost = process.env.ANALYTICS_INTERNAL_HOST ?? '127.0.0.1:3000'
  const trackUrl = `http://${internalHost}/api/track`

  const trackPromise = fetch(trackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: pathname,
      referrer,
      ip,
      ua,
      country,
    }),
  }).catch((err: unknown) => {
    // 失败时 console.error 让 PM2 log 可见（调试用，不影响主站可用性）
    // eslint-disable-next-line no-console
    console.error('[analytics-middleware] track failed:', err instanceof Error ? err.message : String(err))
  })

  event.waitUntil(trackPromise)
  return NextResponse.next()
}
