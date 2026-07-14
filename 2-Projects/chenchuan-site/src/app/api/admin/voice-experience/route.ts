import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import {
  generateVoiceExperienceCode,
  listVoiceExperienceCodes,
  resetVoiceVisitor,
  revokeVoiceExperienceCode,
} from '@/lib/chat/voice-experience'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function ensureAdmin(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  return Boolean(token && (await verifySession(token)))
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ items: listVoiceExperienceCodes() })
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown
    max_uses?: unknown
    valid_days?: unknown
  }
  const item = generateVoiceExperienceCode({
    label: typeof body.label === 'string' ? body.label : undefined,
    maxUses: typeof body.max_uses === 'number' ? body.max_uses : undefined,
    validDays: typeof body.valid_days === 'number' ? body.valid_days : undefined,
  })
  return NextResponse.json({ ok: true, item })
}

export async function PATCH(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = (await request.json().catch(() => ({}))) as { visitor_id?: unknown }
  const visitorId = typeof body.visitor_id === 'string' ? body.visitor_id : ''
  if (!/^V-[A-F0-9]{10}$/i.test(visitorId.trim())) {
    return NextResponse.json({ error: 'invalid_visitor_id' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, reset: resetVoiceVisitor(visitorId) })
}

export async function DELETE(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const codeHint = request.nextUrl.searchParams.get('code_hint')?.trim() ?? ''
  if (!codeHint) return NextResponse.json({ error: 'missing_code_hint' }, { status: 400 })
  return NextResponse.json({ ok: revokeVoiceExperienceCode(codeHint) })
}
