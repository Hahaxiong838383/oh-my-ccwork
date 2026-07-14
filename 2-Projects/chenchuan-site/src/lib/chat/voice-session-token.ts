import 'server-only'
import { SignJWT, jwtVerify } from 'jose'

const secret = new TextEncoder().encode(
  process.env.VOICE_SESSION_SIGNING_SECRET ??
    process.env.ANALYTICS_JWT_SECRET ??
    'dev-voice-secret-please-set-prod-env-min-32-chars',
)

export interface VoiceSessionClaims {
  roomId: string
  reservationId: string
  cookieHash: string
}

export async function signVoiceSession(claims: VoiceSessionClaims, expiresAt: number): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000) + 30)
    .sign(secret)
}

export async function verifyVoiceSession(token: string): Promise<VoiceSessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    if (
      typeof payload.roomId === 'string' &&
      typeof payload.reservationId === 'string' &&
      typeof payload.cookieHash === 'string'
    ) {
      return {
        roomId: payload.roomId,
        reservationId: payload.reservationId,
        cookieHash: payload.cookieHash,
      }
    }
    return null
  } catch {
    return null
  }
}
