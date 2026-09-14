'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Mic, PhoneOff, Play, ShieldCheck, Ticket, Volume2, X } from 'lucide-react'
import { getOrCreateCookieId } from '@/lib/chat/cookie-id'

const AGENT_BRIEF = { LISTENING: 1, THINKING: 2, SPEAKING: 3, INTERRUPTED: 4, FINISHED: 5 } as const
const BOT_USER_ID = 'myjavis_bot'

type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error'

interface VoiceQuota {
  enabled: boolean
  visitorId: string
  remaining: number
  maxSeconds: number
}

interface StartResponse {
  ok: boolean
  error?: string
  appId: string
  roomId: string
  userId: string
  token: string
  taskId: string
  expiresAt: number
  maxSeconds: number
  sessionToken: string
  visitorId: string
}

interface ActiveSession {
  cookieId: string
  sessionToken: string
  expiresAt: number
}

function tlv2String(buffer: ArrayBuffer): { type: string; value: string } {
  const typeBuffer = new Uint8Array(buffer, 0, 4)
  const lengthBuffer = new Uint8Array(buffer, 4, 4)
  const valueBuffer = new Uint8Array(buffer, 8)
  let type = ''
  for (const byte of typeBuffer) type += String.fromCharCode(byte)
  const length =
    ((lengthBuffer[0] ?? 0) << 24) |
    ((lengthBuffer[1] ?? 0) << 16) |
    ((lengthBuffer[2] ?? 0) << 8) |
    (lengthBuffer[3] ?? 0)
  return { type, value: new TextDecoder().decode(valueBuffer.subarray(0, length)) }
}

function friendlyError(error: string): string {
  if (error === 'voice_quota_exceeded') return '今天的公开体验已用完。联系陈川获取新的 2 分钟体验码。'
  if (error === 'invalid_experience_code') return '体验码无效、已用完或已过期。'
  if (error === 'voice_session_already_active') return '这个浏览器已有一段语音正在进行，请稍后再试。'
  if (error === 'public_voice_busy') return '当前语音通道正忙，请稍后再试。'
  if (error === 'voice_feature_disabled') return '语音体验暂未开放，可以尝试文字问答。'
  return '语音连接没有成功，请稍后重试。'
}

const STATE_COPY: Record<VoiceState, string> = {
  idle: '准备就绪',
  connecting: '正在接通 MyJavis',
  listening: '正在听你说',
  thinking: '正在生成回答',
  speaking: 'AI 正在回答',
  ended: '本次体验已结束',
  error: '连接未成功',
}

export function VoiceMirrorExperience({ onClose }: { onClose?: () => void }) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const engineRef = useRef<any>(null)
  const vertcRef = useRef<any>(null)
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const sessionRef = useRef<ActiveSession | null>(null)
  const failedUsersRef = useRef<Set<string>>(new Set())
  const stoppingRef = useRef(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [quota, setQuota] = useState<VoiceQuota | null>(null)
  const [experienceCode, setExperienceCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userSubtitle, setUserSubtitle] = useState('')
  const [assistantSubtitle, setAssistantSubtitle] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(120)
  const [needTapToPlay, setNeedTapToPlay] = useState(false)

  const refreshQuota = useCallback(async () => {
    const cookieId = getOrCreateCookieId()
    try {
      const response = await fetch(`/api/chat/voice/quota?cookie_id=${encodeURIComponent(cookieId)}`, {
        cache: 'no-store',
      })
      if (response.ok) setQuota((await response.json()) as VoiceQuota)
    } catch {
      setQuota(null)
    }
  }, [])

  useEffect(() => {
    void refreshQuota()
  }, [refreshQuota])

  const closeRtcEngine = useCallback(async () => {
    const engine = engineRef.current
    if (!engine) return
    try {
      await engine.stopAudioCapture()
    } catch {
      // ignore
    }
    try {
      await engine.leaveRoom()
    } catch {
      // ignore
    }
    vertcRef.current?.destroyEngine?.(engine)
    engineRef.current = null
  }, [])

  const stop = useCallback(
    async (nextState: VoiceState = 'ended') => {
      if (stoppingRef.current) return
      stoppingRef.current = true
      await closeRtcEngine()
      const active = sessionRef.current
      sessionRef.current = null
      if (active) {
        void fetch('/api/chat/voice/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookie_id: active.cookieId, session_token: active.sessionToken }),
          keepalive: true,
        }).catch(() => undefined)
      }
      failedUsersRef.current.clear()
      setNeedTapToPlay(false)
      setState(nextState)
      stoppingRef.current = false
      void refreshQuota()
    },
    [closeRtcEngine, refreshQuota],
  )

  useEffect(() => {
    if (!sessionRef.current || state === 'ended' || state === 'error') return
    const timer = window.setInterval(() => {
      const active = sessionRef.current
      if (!active) return
      const left = Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left <= 0) void stop('ended')
    }, 250)
    return () => window.clearInterval(timer)
  }, [state, stop])

  useEffect(() => {
    const endOnLeave = () => {
      const active = sessionRef.current
      if (!active) return
      void fetch('/api/chat/voice/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cookie_id: active.cookieId, session_token: active.sessionToken }),
        keepalive: true,
      }).catch(() => undefined)
    }
    window.addEventListener('pagehide', endOnLeave)
    return () => {
      window.removeEventListener('pagehide', endOnLeave)
      endOnLeave()
      void closeRtcEngine()
    }
  }, [closeRtcEngine])

  const start = useCallback(async () => {
    if (state === 'connecting' || sessionRef.current) return
    setState('connecting')
    setError(null)
    setUserSubtitle('')
    setAssistantSubtitle('')
    const cookieId = getOrCreateCookieId()
    try {
      const response = await fetch('/api/chat/voice/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cookie_id: cookieId,
          ...(experienceCode.trim() ? { experience_code: experienceCode.trim() } : {}),
        }),
      })
      const data = (await response.json()) as StartResponse
      if (!response.ok || !data.ok) throw new Error(data.error || 'voice_start_failed')
      sessionRef.current = {
        cookieId,
        sessionToken: data.sessionToken,
        expiresAt: data.expiresAt,
      }
      setSecondsLeft(data.maxSeconds)

      const rtcMod: any = await import('@volcengine/rtc') // eslint-disable-line @typescript-eslint/no-explicit-any
      const VERTC = rtcMod.default
      const engine = VERTC.createEngine(data.appId)
      engineRef.current = engine
      vertcRef.current = VERTC

      engine.on(
        VERTC.events.onRoomBinaryMessageReceived,
        ((event: { message: ArrayBuffer }) => {
          try {
            const { type, value } = tlv2String(event.message)
            if (type === 'conv') {
              const code = JSON.parse(value)?.Stage?.Code
              if (code === AGENT_BRIEF.THINKING) setState('thinking')
              else if (code === AGENT_BRIEF.SPEAKING) setState('speaking')
              else if (
                code === AGENT_BRIEF.LISTENING ||
                code === AGENT_BRIEF.FINISHED ||
                code === AGENT_BRIEF.INTERRUPTED
              ) {
                setState('listening')
              }
            } else if (type === 'subv') {
              const subtitle = JSON.parse(value)?.data?.[0]
              if (subtitle?.text && subtitle.userId) {
                if (subtitle.userId === data.userId) setUserSubtitle(String(subtitle.text))
                else setAssistantSubtitle(String(subtitle.text))
              }
            }
          } catch {
            // malformed RTC message does not end the call
          }
        }) as never,
      )
      engine.on(
        VERTC.events.onAutoplayFailed,
        ((event: { userId?: string }) => {
          if (event.userId) failedUsersRef.current.add(event.userId)
          setNeedTapToPlay(true)
        }) as never,
      )

      await engine.joinRoom(
        data.token,
        data.roomId,
        { userId: data.userId, extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC', user_id: data.userId }) },
        {
          isAutoPublish: true,
          isAutoSubscribeAudio: true,
          roomProfileType: rtcMod.RoomProfileType.chat,
        },
      )
      await engine.startAudioCapture()
      await engine.publishStream(rtcMod.MediaType.AUDIO)
      setState('listening')
      setExperienceCode('')
      setShowCode(false)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(friendlyError(message))
      if (message === 'voice_quota_exceeded') setShowCode(true)
      await stop('error')
    }
  }, [experienceCode, state, stop])

  const resumePlay = () => {
    const engine = engineRef.current
    if (engine) {
      for (const userId of failedUsersRef.current) {
        try {
          engine.play?.(userId || BOT_USER_ID)
        } catch {
          // ignore
        }
      }
    }
    failedUsersRef.current.clear()
    setNeedTapToPlay(false)
  }

  const active = ['connecting', 'listening', 'thinking', 'speaking'].includes(state)
  const quotaUsed = quota?.remaining === 0

  return (
    <section className="relative overflow-hidden rounded-[28px] border border-[#8F7CFF]/30 bg-[#080A12] text-white shadow-[0_30px_100px_rgba(0,0,0,0.42)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_15%,rgba(109,91,208,0.24),transparent_38%),radial-gradient(circle_at_18%_80%,rgba(56,189,248,0.12),transparent_34%)]" />
      <div className="relative p-5 sm:p-7">
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-[#9B8CFF]">
              MyJavis · Live Voice
            </div>
            <h2 className="mt-2 text-xl font-semibold sm:text-2xl">用语音聊项目和产品思路</h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/60">
              支持语音问答和打断。公开体验最长 2 分钟。
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={() => {
                void stop('ended')
                onClose()
              }}
              className="rounded-full border border-white/10 p-2 text-white/55 transition hover:border-white/30 hover:text-white"
              aria-label="关闭语音体验"
            >
              <X size={18} />
            </button>
          )}
        </header>

        <div className="mt-6 grid gap-5 md:grid-cols-[0.72fr_1.28fr]">
          <div className="flex min-h-[250px] flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className={`voice-mirror-orb voice-mirror-orb--${state}`} aria-hidden>
              <span />
              <span />
              <span />
              <Mic size={30} className="relative z-10" />
            </div>
            <div className="mt-5 font-mono text-xs uppercase tracking-[0.18em] text-[#B8ADFF]" aria-live="polite">
              {STATE_COPY[state]}
            </div>
            {active && (
              <div className="mt-2 font-mono text-2xl tabular-nums text-white">
                {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
              </div>
            )}
          </div>

          <div className="flex flex-col justify-between rounded-2xl border border-white/10 bg-black/20 p-5">
            <div>
              <div className="flex items-center gap-2 text-xs text-white/50">
                <ShieldCheck size={15} className="text-emerald-300" />
                明确告知：这是 AI，不是陈川本人
              </div>
              <div className="mt-4 space-y-3" aria-live="polite">
                <Subtitle label="你" text={userSubtitle || '开口说一个具体问题，例如：这个 AI 产品方向值不值得做？'} />
                <Subtitle label="AI 回答" text={assistantSubtitle || '接通后可以直接提问。'} accent />
              </div>
              <p className="mt-4 text-[11px] leading-relaxed text-white/40">
                公开会话不启用长期记忆、声纹、提醒、音乐与设备控制；本站不保存录音和对话转写。
              </p>
            </div>

            <div className="mt-5">
              {error && <div className="mb-3 rounded-lg border border-rose-400/25 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">{error}</div>}
              {needTapToPlay && (
                <button type="button" onClick={resumePlay} className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-4 py-2.5 text-sm font-semibold text-black">
                  <Volume2 size={16} /> 点击恢复 AI 声音
                </button>
              )}
              {!active && showCode && (
                <label className="mb-3 block">
                  <span className="mb-1.5 flex items-center gap-1.5 text-xs text-white/60"><Ticket size={14} /> 2 分钟体验码</span>
                  <input
                    value={experienceCode}
                    onChange={(event) => setExperienceCode(event.target.value.toUpperCase())}
                    placeholder="CC-XXXX-XXXX-XXXX-XXXX"
                    className="w-full rounded-xl border border-white/15 bg-black/35 px-3 py-2.5 font-mono text-sm uppercase text-white outline-none transition focus:border-[#9B8CFF]"
                  />
                </label>
              )}
              {active ? (
                <button type="button" onClick={() => void stop('ended')} className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-400/20">
                  <PhoneOff size={17} /> 结束语音
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={state === 'connecting' || quota?.enabled === false || (quotaUsed && !experienceCode.trim())}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#725EFF] to-[#9B8CFF] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_rgba(114,94,255,0.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {state === 'connecting' ? <Headphones className="animate-pulse" size={17} /> : <Play size={17} fill="currentColor" />}
                  {state === 'connecting' ? '正在接通' : experienceCode.trim() ? '使用体验码开始' : '开始 2 分钟实时语音'}
                </button>
              )}
              {!active && (
                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-white/40">
                  <span>体验编号：{quota?.visitorId ?? '加载中'}</span>
                  <button type="button" onClick={() => setShowCode((value) => !value)} className="text-[#B8ADFF] hover:text-white">
                    {showCode ? '隐藏体验码' : quotaUsed ? '输入体验码' : '我有体验码'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Subtitle({ label, text, accent = false }: { label: string; text: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${accent ? 'border-[#8F7CFF]/25 bg-[#8F7CFF]/[0.08]' : 'border-white/8 bg-white/[0.025]'}`}>
      <div className={`mb-1 font-mono text-[9px] uppercase tracking-[0.16em] ${accent ? 'text-[#B8ADFF]' : 'text-white/35'}`}>{label}</div>
      <div className="min-h-[2.6em] text-sm leading-relaxed text-white/80">{text}</div>
    </div>
  )
}
