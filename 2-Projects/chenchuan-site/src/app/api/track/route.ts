import { NextResponse } from 'next/server'
import { trackVisit } from '@/lib/analytics/track'

// Node.js runtime（better-sqlite3 是 native module，不能在 Edge）
export const runtime = 'nodejs'
// 不缓存，每次都走（实际上 POST 本来就不会被缓存）
export const dynamic = 'force-dynamic'

interface TrackPayload {
  path?: unknown
  referrer?: unknown
  ip?: unknown
  ua?: unknown
  country?: unknown
}

function asString(v: unknown, fallback: string | null = null): string | null {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

// POST /api/track —— middleware 异步触发
// 任何错误都吞掉返回 204（不能让记录失败影响主站）
export async function POST(req: Request): Promise<Response> {
  try {
    const payload = (await req.json()) as TrackPayload
    const path = asString(payload.path, '/') ?? '/'
    const ip = asString(payload.ip, 'unknown') ?? 'unknown'
    trackVisit({
      path,
      referrer: asString(payload.referrer),
      ip,
      ua: asString(payload.ua),
      country: asString(payload.country),
    })
  } catch {
    // 静默吞错
  }
  return new NextResponse(null, { status: 204 })
}
