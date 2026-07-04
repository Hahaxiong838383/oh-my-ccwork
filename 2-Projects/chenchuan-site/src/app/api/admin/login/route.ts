import { NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, signSession, verifyCredentials } from '@/lib/analytics/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface LoginPayload {
  username?: unknown
  password?: unknown
}

// 简单 rate limit：同 IP 1 分钟最多 5 次错密码（内存计数器，重启清零）
const FAILED_ATTEMPTS = new Map<string, { count: number; firstAt: number }>()
const RATE_WINDOW_MS = 60_000
const MAX_FAILS = 5

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const record = FAILED_ATTEMPTS.get(ip)
  if (!record || now - record.firstAt > RATE_WINDOW_MS) {
    FAILED_ATTEMPTS.set(ip, { count: 0, firstAt: now })
    return true
  }
  return record.count < MAX_FAILS
}

function recordFailure(ip: string): void {
  const record = FAILED_ATTEMPTS.get(ip)
  if (record) {
    record.count += 1
  } else {
    FAILED_ATTEMPTS.set(ip, { count: 1, firstAt: Date.now() })
  }
}

function recordSuccess(ip: string): void {
  FAILED_ATTEMPTS.delete(ip)
}

export async function POST(req: Request): Promise<NextResponse> {
  const ip =
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'

  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'too_many_attempts' }, { status: 429 })
  }

  let payload: LoginPayload
  try {
    payload = (await req.json()) as LoginPayload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const username = typeof payload.username === 'string' ? payload.username : ''
  const password = typeof payload.password === 'string' ? payload.password : ''

  if (!username || !password) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 })
  }

  const ok = await verifyCredentials(username, password)
  if (!ok) {
    recordFailure(ip)
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
  }

  recordSuccess(ip)
  const token = await signSession({ username })
  const response = NextResponse.json({ ok: true })
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  })
  return response
}
