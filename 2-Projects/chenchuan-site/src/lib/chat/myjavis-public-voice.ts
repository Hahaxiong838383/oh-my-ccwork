import 'server-only'

interface PublicVoiceStartResponse {
  ok: boolean
  error?: string
  appId: string
  roomId: string
  userId: string
  token: string
  taskId: string
  expiresAt: number
  maxSeconds: number
}

function config(): { baseUrl: string; secret: string } {
  const baseUrl = (process.env.MYJAVIS_PUBLIC_VOICE_BASE_URL ?? '').replace(/\/$/, '')
  const secret = process.env.MYJAVIS_PUBLIC_VOICE_SHARED_SECRET ?? ''
  if (!baseUrl || !secret || (process.env.PUBLIC_VOICE_ENABLED ?? '0') !== '1') {
    throw new Error('voice_feature_disabled')
  }
  return { baseUrl, secret }
}

async function request(path: string, body?: unknown): Promise<Response> {
  const { baseUrl, secret } = config()
  return fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'x-public-voice-secret': secret,
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  })
}

export async function startMyJavisPublicVoice(input: {
  systemPrompt: string
  promptVersion: string
  maxSeconds: number
}): Promise<PublicVoiceStartResponse> {
  const response = await request('/public-voice/start', input)
  const data = (await response.json()) as PublicVoiceStartResponse
  if (!response.ok || !data.ok) throw new Error(data.error || `myjavis_http_${response.status}`)
  return data
}

export async function stopMyJavisPublicVoice(roomId: string): Promise<void> {
  const response = await request('/public-voice/stop', { roomId })
  if (!response.ok) throw new Error(`myjavis_stop_http_${response.status}`)
}
