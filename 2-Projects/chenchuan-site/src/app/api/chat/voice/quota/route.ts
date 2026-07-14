import { NextResponse } from 'next/server'
import { getVoiceQuota } from '@/lib/chat/voice-experience'
import { hashIp, resolveClientIp } from '@/lib/chat/quota'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const cookieId = new URL(req.url).searchParams.get('cookie_id')?.trim() ?? ''
  if (!cookieId || cookieId.length > 200) {
    return NextResponse.json({ error: 'missing_cookie_id' }, { status: 400 })
  }
  const ipHash = hashIp(resolveClientIp(req.headers))
  return NextResponse.json({
    enabled: (process.env.PUBLIC_VOICE_ENABLED ?? '0') === '1',
    ...getVoiceQuota(cookieId, ipHash),
  })
}
