import { NextResponse } from 'next/server'
import { stopMyJavisPublicVoice } from '@/lib/chat/myjavis-public-voice'
import { stopVoiceExperience, voiceCookieHash } from '@/lib/chat/voice-experience'
import { verifyVoiceSession } from '@/lib/chat/voice-session-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  let body: { cookie_id?: unknown; session_token?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const cookieId = typeof body.cookie_id === 'string' ? body.cookie_id.trim() : ''
  const token = typeof body.session_token === 'string' ? body.session_token : ''
  const claims = token ? await verifyVoiceSession(token) : null
  if (!cookieId || !claims || claims.cookieHash !== voiceCookieHash(cookieId)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    await stopMyJavisPublicVoice(claims.roomId)
  } catch {
    // MyJavis 有独立硬超时；停止请求失败不妨碍本地会话闭合。
  } finally {
    stopVoiceExperience(claims.reservationId)
  }
  return NextResponse.json({ ok: true })
}
