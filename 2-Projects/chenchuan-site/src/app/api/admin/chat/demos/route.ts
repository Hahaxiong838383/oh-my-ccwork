import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import {
  deleteClassicDemo,
  getClassicDemoById,
  listClassicDemos,
  saveClassicDemo,
  type DemoRoutingStep,
} from '@/lib/chat/demos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SavePayload {
  id?: unknown
  category?: unknown
  question?: unknown
  routing?: unknown
  featured?: unknown
  quality_score?: unknown
}

async function ensureAdmin(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!token) return false
  const claims = await verifySession(token)
  return Boolean(claims)
}

function parseRouting(input: unknown): DemoRoutingStep[] | null {
  if (!Array.isArray(input)) return null
  return input as DemoRoutingStep[]
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const id = request.nextUrl.searchParams.get('id')
  if (id) {
    const demo = getClassicDemoById(id)
    if (!demo) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ demo })
  }

  const limitRaw = request.nextUrl.searchParams.get('limit')
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100
  return NextResponse.json({ items: listClassicDemos(Number.isFinite(limit) ? limit : 100) })
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let payload: SavePayload
  try {
    payload = (await request.json()) as SavePayload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const id = typeof payload.id === 'string' ? payload.id.trim() : ''
  const category = typeof payload.category === 'string' ? payload.category.trim() : ''
  const question = typeof payload.question === 'string' ? payload.question.trim() : ''
  const routing = parseRouting(payload.routing)

  if (!id || !category || !question || !routing) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }

  const demo = saveClassicDemo({
    id,
    category,
    question,
    routing,
    featured: Boolean(payload.featured),
    quality_score:
      typeof payload.quality_score === 'number' && Number.isFinite(payload.quality_score)
        ? payload.quality_score
        : 50,
  })

  return NextResponse.json({ ok: true, demo })
}

export async function PUT(request: NextRequest): Promise<Response> {
  return POST(request)
}

export async function DELETE(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let id = request.nextUrl.searchParams.get('id') ?? ''
  if (!id) {
    try {
      const payload = (await request.json()) as { id?: unknown }
      id = typeof payload.id === 'string' ? payload.id : ''
    } catch {
      id = ''
    }
  }

  if (!id) {
    return NextResponse.json({ error: 'missing_id' }, { status: 400 })
  }

  const deleted = deleteClassicDemo(id)
  if (!deleted) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
