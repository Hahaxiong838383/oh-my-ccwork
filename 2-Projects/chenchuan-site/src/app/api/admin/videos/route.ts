import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/analytics/auth'
import {
  deleteManagedVideo,
  getManagedVideoById,
  listManagedVideos,
  saveManagedVideo,
} from '@/lib/videos/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SavePayload {
  id?: unknown
  title?: unknown
  description?: unknown
  url?: unknown
  thumbnail?: unknown
  duration?: unknown
  tags?: unknown
  projectSlug?: unknown
  published?: unknown
  sort?: unknown
}

async function ensureAdmin(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value
  if (!token) return false
  const claims = await verifySession(token)
  return Boolean(claims)
}

function parseTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((t): t is string => typeof t === 'string')
  return []
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!(await ensureAdmin(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const id = request.nextUrl.searchParams.get('id')
  if (id) {
    const video = getManagedVideoById(id)
    if (!video) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ video })
  }

  const limitRaw = request.nextUrl.searchParams.get('limit')
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 500
  return NextResponse.json({ items: listManagedVideos(Number.isFinite(limit) ? limit : 500) })
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
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  const url = typeof payload.url === 'string' ? payload.url.trim() : ''

  if (!id || !title || !url) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }

  const projectSlug =
    typeof payload.projectSlug === 'string' && payload.projectSlug.trim()
      ? payload.projectSlug.trim()
      : null
  const sort =
    typeof payload.sort === 'number' && Number.isFinite(payload.sort) ? payload.sort : 0

  const video = saveManagedVideo({
    id,
    title,
    description: typeof payload.description === 'string' ? payload.description : '',
    url,
    thumbnail: typeof payload.thumbnail === 'string' ? payload.thumbnail : '',
    duration: typeof payload.duration === 'string' ? payload.duration : '',
    tags: parseTags(payload.tags),
    projectSlug,
    published: payload.published !== false,
    sort,
  })

  return NextResponse.json({ ok: true, video })
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

  const deleted = deleteManagedVideo(id)
  if (!deleted) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
