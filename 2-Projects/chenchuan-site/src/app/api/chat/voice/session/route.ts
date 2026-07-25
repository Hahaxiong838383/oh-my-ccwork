import { NextResponse } from 'next/server'
import { hashIp, resolveClientIp } from '@/lib/chat/quota'
import {
  activateVoiceExperience,
  failVoiceReservation,
  getVoiceQuota,
  reserveVoiceExperience,
  VOICE_DEFAULT_SECONDS,
} from '@/lib/chat/voice-experience'
import { startMyJavisPublicVoice, stopMyJavisPublicVoice } from '@/lib/chat/myjavis-public-voice'
import {
  getStrategicMirrorVoicePrompt,
  STRATEGIC_MIRROR_VOICE_PROMPT_VERSION,
} from '@/lib/chat/system-prompt'
import { signVoiceSession } from '@/lib/chat/voice-session-token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Payload {
  cookie_id?: unknown
  experience_code?: unknown
}

function statusForError(message: string): number {
  if (message === 'voice_quota_exceeded' || message === 'invalid_experience_code') return 403
  if (message === 'voice_session_already_active') return 409
  if (message === 'public_voice_busy') return 429
  if (message === 'voice_feature_disabled') return 503
  return 502
}

export async function POST(req: Request): Promise<Response> {
  let payload: Payload
  try {
    payload = (await req.json()) as Payload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const cookieId = typeof payload.cookie_id === 'string' ? payload.cookie_id.trim() : ''
  const experienceCode =
    typeof payload.experience_code === 'string' ? payload.experience_code.trim() : undefined
  if (!cookieId || cookieId.length > 200 || (experienceCode?.length ?? 0) > 80) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }

  const ipHash = hashIp(resolveClientIp(req.headers))
  let reservation: ReturnType<typeof reserveVoiceExperience> | null = null
  try {
    reservation = reserveVoiceExperience(cookieId, ipHash, experienceCode)
    const maxSeconds = Math.max(
      30,
      Math.min(Number(process.env.PUBLIC_VOICE_MAX_SECONDS ?? VOICE_DEFAULT_SECONDS), 180),
    )
    const rtc = await startMyJavisPublicVoice({
      systemPrompt: getStrategicMirrorVoicePrompt(),
      promptVersion: STRATEGIC_MIRROR_VOICE_PROMPT_VERSION,
      maxSeconds,
    })
    let sessionToken: string
    try {
      sessionToken = await signVoiceSession(
        {
          roomId: rtc.roomId,
          reservationId: reservation.id,
          cookieHash: reservation.cookieHash,
        },
        rtc.expiresAt,
      )
      activateVoiceExperience(reservation.id, rtc.roomId, rtc.expiresAt)
    } catch (error) {
      await stopMyJavisPublicVoice(rtc.roomId).catch(() => undefined)
      throw error
    }
    return NextResponse.json({
      ok: true,
      appId: rtc.appId,
      roomId: rtc.roomId,
      userId: rtc.userId,
      token: rtc.token,
      taskId: rtc.taskId,
      expiresAt: rtc.expiresAt,
      maxSeconds: rtc.maxSeconds,
      sessionToken,
      visitorId: reservation.visitorId,
      quota: getVoiceQuota(cookieId, ipHash),
    })
  } catch (error) {
    if (reservation) failVoiceReservation(reservation.id)
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: statusForError(message) })
  }
}
