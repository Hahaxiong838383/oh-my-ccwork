'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getOrCreateCookieId } from '@/lib/chat/cookie-id'

// 自由提问面板：消息列表 + 输入框 + SSE 流式输出 + 限额提示 + 加微信 CTA
// 限额与路由由后端控制；展示不把兼容路由字段当成真实模型标识。

interface Message {
  role: 'user' | 'assistant'
  content: string
  routing?: { engine: 'cc' | 'codex' | 'gemini'; label: string }
  isStreaming?: boolean
  startedAt?: number
}

// 空状态示例问题：点击直接发送（降低小白冷启动门槛）
const SAMPLE_QUESTIONS = [
  '陈川最近做了哪些 AI 产品项目？',
  '我们公司想做 AI 应用，怎么判断有没有市场？',
  '招 AI 产品经理时，看哪些能力最关键？',
  '想从传统行业转型做 AI 产品，第一步该做什么？',
]

type QuotaState =
  | { kind: 'loading' }
  | { kind: 'ready'; remaining: number; dailyCentsRemaining: number; blacklisted: boolean }
  | { kind: 'error'; message: string }

export function FreeAskPanel() {
  const [cookieId, setCookieId] = useState('')
  const [quota, setQuota] = useState<QuotaState>({ kind: 'loading' })
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null)

  // 首次挂载：生成/取 cookie_id + 查 quota
  useEffect(() => {
    const id = getOrCreateCookieId()
    setCookieId(id)
    refreshQuota(id)
  }, [])

  // 消息更新时滚动到底
  useEffect(() => {
    if (scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages])

  // cleanup abort on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const refreshQuota = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/chat/quota?cookie_id=${encodeURIComponent(id)}`)
      if (!res.ok) {
        setQuota({ kind: 'error', message: `quota_${res.status}` })
        return
      }
      const data = (await res.json()) as {
        remaining: number
        daily_cents_remaining: number
        blacklisted: boolean
      }
      setQuota({
        kind: 'ready',
        remaining: data.remaining,
        dailyCentsRemaining: data.daily_cents_remaining,
        blacklisted: data.blacklisted,
      })
    } catch (err) {
      setQuota({ kind: 'error', message: err instanceof Error ? err.message : 'network' })
    }
  }, [])

  const send = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || isStreaming || !cookieId) return
    if (quota.kind === 'ready' && quota.remaining <= 0) return
    if (quota.kind === 'ready' && quota.dailyCentsRemaining <= 0) return

    setErrorMsg(null)
    setInput('')
    const userMsg: Message = { role: 'user', content: text }
    const assistantMsg: Message = { role: 'assistant', content: '', isStreaming: true, startedAt: Date.now() }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookie_id: cookieId,
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        const errCode = (errBody as { error?: string }).error ?? `http_${res.status}`
        handleErrorCode(errCode)
        // error 路径：删 streaming assistant + 最后一条 user（即刚 push 的 userMsg）
        setMessages((prev) => {
          let lastUserIdx = -1
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'user') { lastUserIdx = i; break }
          }
          return prev.filter((m, i) =>
            !(m.role === 'assistant' && m.isStreaming) && i !== lastUserIdx,
          )
        })
        setIsStreaming(false)
        await refreshQuota(cookieId)
        return
      }

      if (!res.body) {
        throw new Error('no_response_body')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      // 完整流式解析 SSE：event/data 多行 + \n\n 分隔
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })

        let sepIdx = buffer.indexOf('\n\n')
        while (sepIdx >= 0) {
          const eventBlock = buffer.slice(0, sepIdx)
          buffer = buffer.slice(sepIdx + 2)
          processSseBlock(eventBlock)
          sepIdx = buffer.indexOf('\n\n')
        }
      }
      if (buffer.trim()) processSseBlock(buffer)

      setIsStreaming(false)
      // mark assistant as no longer streaming
      setMessages((prev) =>
        prev.map((m) => (m.role === 'assistant' && m.isStreaming ? { ...m, isStreaming: false } : m)),
      )
      await refreshQuota(cookieId)
    } catch (err) {
      if (controller.signal.aborted) {
        // 用户主动中止
        setIsStreaming(false)
        return
      }
      setErrorMsg(err instanceof Error ? err.message : 'stream_error')
      setIsStreaming(false)
    }

    function processSseBlock(block: string) {
      const lines = block.split('\n')
      let eventName = 'message'
      let dataStr = ''
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
      }
      if (!dataStr) return
      let payload: unknown
      try {
        payload = JSON.parse(dataStr)
      } catch {
        return
      }

      if (eventName === 'routing') {
        const data = payload as { stage?: string; engine?: string; label?: string }
        if (data.stage === 'thinking' && data.engine && data.label) {
          setMessages((prev) =>
            prev.map((m) =>
              m.role === 'assistant' && m.isStreaming
                ? {
                    ...m,
                    routing: {
                      engine: data.engine as 'cc' | 'codex' | 'gemini',
                      label: data.label!,
                    },
                  }
                : m,
            ),
          )
        }
      } else if (eventName === 'token') {
        const data = payload as { delta?: string }
        if (data.delta) {
          setMessages((prev) =>
            prev.map((m) =>
              m.role === 'assistant' && m.isStreaming ? { ...m, content: m.content + data.delta } : m,
            ),
          )
        }
      } else if (eventName === 'error') {
        const data = payload as { reason?: string }
        setErrorMsg(`流式输出中断：${data.reason ?? 'unknown'}`)
      }
    }

    function handleErrorCode(code: string) {
      if (code === 'quota_exceeded') {
        setErrorMsg('本浏览器自由提问额度已用完。')
      } else if (code === 'budget_exhausted') {
        setErrorMsg('今日全站自由咨询额度已用完，明天再来或加微信继续。')
      } else if (code === 'blacklisted') {
        setErrorMsg('当前 IP 短时间内消耗过快，已暂停 24h。请联系陈川。')
      } else if (code === 'missing_cookie_id' || code === 'bad_request') {
        setErrorMsg('请求异常，请刷新页面重试。')
      } else if (code === 'invalid_messages') {
        setErrorMsg('消息格式异常，请刷新重试。')
      } else {
        setErrorMsg(`服务端异常 (${code})，稍后重试。`)
      }
    }
  }, [cookieId, input, isStreaming, messages, quota, refreshQuota])

  // 渲染 ===
  const ready = quota.kind === 'ready' ? quota : null
  const blocked =
    quota.kind === 'ready' &&
    (quota.remaining <= 0 || quota.dailyCentsRemaining <= 0 || quota.blacklisted)

  return (
    <section className="rounded-lg border border-white/10 bg-white/[0.02] p-5">
      {/* 顶部 */}
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/85">
            自由提问 · Live
          </div>
          <div className="text-[11px] text-white/55">
            实时流式回答 · AI 原生工作方法论（限额防恶意刷量）
          </div>
        </div>
        <QuotaBadge quota={quota} />
      </header>

      {/* 消息列表（有消息时显示对话；无消息时显示思考容器占位，体现"thinking 空间") */}
      <div className="mb-4 min-h-[360px] space-y-3 overflow-y-auto rounded border border-white/[0.06] bg-black/30 p-4 lg:max-h-[640px] lg:min-h-[440px]">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-4 px-2 text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
              输入问题，开始文字问答
            </div>
            <div className="text-[12px] text-white/55">不知道问什么？点一下就开聊 👇</div>
            <div className="w-full max-w-md space-y-2">
              {SAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={isStreaming || quota.kind !== 'ready' || blocked}
                  onClick={() => void send(q)}
                  className="group flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-[13px] text-white/75 transition-all duration-200 hover:border-[#7FE5FF]/45 hover:bg-[#7FE5FF]/[0.05] hover:text-[#7FE5FF] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="leading-snug">{q}</span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-white/25 transition group-hover:text-[#7FE5FF]">
                    一键问 →
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m, idx) => (
              <MessageBubble key={idx} message={m} />
            ))}
            <div ref={scrollAnchorRef} />
          </>
        )}
      </div>

      {/* 错误提示 */}
      {errorMsg && (
        <div className="mb-3 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12px] text-red-200">
          {errorMsg}
        </div>
      )}

      {/* 输入区 或 加微信 CTA */}
      {blocked ? (
        <UpsellCta reason={quota.kind === 'ready' && quota.blacklisted ? 'blacklisted' : quota.kind === 'ready' && quota.dailyCentsRemaining <= 0 ? 'budget' : 'quota'} />
      ) : (
        <div>
          {/* 引导文案：明确指向下方输入框 */}
          <div className="mb-2 flex items-center gap-1.5 pl-0.5 text-[12px] text-[#7FE5FF]/80">
            <span aria-hidden>👇</span>
            <span>在这里输入你的问题，免费聊 3 轮</span>
          </div>

          {/* 输入容器：textarea + 发送按钮框在一起，聚焦时整体泛青光（仿主流 AI 输入框） */}
          <div className="rounded-xl border border-white/20 bg-black/50 p-2.5 transition-all duration-200 focus-within:border-[#7FE5FF]/70 focus-within:shadow-[0_0_18px_rgba(127,229,255,0.15)]">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter 直接发送，Shift+Enter 换行；中文输入法选词的 Enter 不触发
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="比如：H 平台解决什么问题？小可的语音方案怎么设计？"
              rows={3}
              disabled={isStreaming || quota.kind !== 'ready'}
              className="w-full resize-none border-0 bg-transparent px-1.5 py-1 text-[14px] text-white placeholder:text-white/35 focus:outline-none focus:ring-0"
            />
            <div className="mt-1 flex items-center justify-between gap-3 pl-1.5">
              <div className="font-mono text-[10px] text-white/30">
                Enter 发送 · Shift+Enter 换行
              </div>
              <button
                type="button"
                onClick={() => void send()}
                disabled={isStreaming || !input.trim() || quota.kind !== 'ready'}
                className={`shrink-0 rounded-lg px-5 py-2 text-[13px] font-semibold transition-all duration-200 ${
                  isStreaming || !input.trim() || quota.kind !== 'ready'
                    ? 'cursor-not-allowed border border-white/10 bg-white/5 text-white/30'
                    : 'bg-[#7FE5FF] text-[#03060b] shadow-[0_0_14px_rgba(127,229,255,0.4)] hover:bg-[#9defff]'
                }`}
              >
                {isStreaming ? '生成中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function QuotaBadge({ quota }: { quota: QuotaState }) {
  if (quota.kind === 'loading') {
    return <span className="font-mono text-[10px] text-white/35">查询额度...</span>
  }
  if (quota.kind === 'error') {
    return <span className="font-mono text-[10px] text-red-300/70">额度查询失败</span>
  }
  if (quota.blacklisted) {
    return (
      <span className="rounded border border-red-400/30 bg-red-400/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-red-200">
        IP 暂停 24h
      </span>
    )
  }
  const isLow = quota.remaining <= 1
  return (
    <span
      className={`rounded border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] tabular-nums ${
        isLow
          ? 'border-amber-300/40 bg-amber-300/10 text-amber-200'
          : 'border-[#7FE5FF]/30 bg-[#7FE5FF]/[0.06] text-[#7FE5FF]'
      }`}
    >
      剩余 {quota.remaining} / 3 轮
    </span>
  )
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-tr-sm border border-[#7FE5FF]/25 bg-[#7FE5FF]/[0.06] px-3.5 py-2 text-[13px] text-white">
          {message.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-lg rounded-tl-sm border border-white/10 bg-black/40 px-3.5 py-2.5">
        <div className="mb-2 text-[11px] text-white/50">AI 回答</div>
        {message.isStreaming && !message.content ? (
          <ThinkingProgress message={message} />
        ) : (
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-white/85">
            {message.content}
            {message.isStreaming && (
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-[#7FE5FF]/80 align-middle" />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ThinkingProgress({ message }: { message: Message }) {
  const [now, setNow] = useState(() => Date.now())
  const startedAt = message.startedAt ?? now
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="min-w-[280px] max-w-xl overflow-hidden rounded-xl border border-[#7FE5FF]/20 bg-[#07131c]/80">
      <div className="relative px-4 py-3">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#7FE5FF]/70 to-transparent" />
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-white">正在生成回答</div>
            <div className="mt-0.5 text-[11px] text-white/48">
              正在等待回答内容，耗时会随问题和连接状态变化。
            </div>
          </div>
          <div className="rounded-full border border-[#7FE5FF]/25 bg-[#7FE5FF]/10 px-2.5 py-1 font-mono text-[10px] tabular-nums text-[#7FE5FF]">
            {elapsedSeconds}s
          </div>
        </div>
        <div className="mb-3 flex items-center gap-2 text-[11px] text-white/62">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#7FE5FF] opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#7FE5FF]" />
          </span>
          <span>等待回答内容…</span>
        </div>
      </div>
    </div>
  )
}

function UpsellCta({ reason }: { reason: 'quota' | 'budget' | 'blacklisted' }) {
  const title =
    reason === 'quota'
      ? '本次文字体验次数已用完'
      : reason === 'budget'
        ? '今日文字体验额度已用完'
        : '当前网络的访问暂时受限'
  const subtitle =
    reason === 'quota'
      ? '可以继续查看项目决策示例，或联系陈川讨论具体问题。'
      : reason === 'budget'
        ? '可以查看已整理的项目决策示例，稍后再来提问。'
        : '当前请求较多，请稍后再试，也可以通过联系页沟通。'
  return (
    <div className="rounded-lg border border-[#7FE5FF]/30 bg-[#7FE5FF]/[0.06] p-5">
      <div className="mb-2 font-medium text-white">{title}</div>
      <p className="mb-4 text-[13px] leading-relaxed text-white/75">{subtitle}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link
          href="/contact"
          className="flex-1 rounded border border-[#7FE5FF]/55 bg-[#7FE5FF]/[0.08] px-4 py-2.5 text-center text-[13px] font-medium text-[#7FE5FF] transition hover:bg-[#7FE5FF]/[0.16] hover:shadow-[0_0_24px_rgba(127,229,255,0.32)]"
        >
          联系陈川 →
        </Link>
        <Link
          href="#classic-demos"
          className="flex-1 rounded border border-white/15 bg-black/30 px-4 py-2.5 text-center text-[13px] text-white/80 transition hover:border-[#7FE5FF]/40 hover:text-[#7FE5FF]"
        >
          查看项目决策示例 ↑
        </Link>
      </div>
      <div className="mt-3 font-mono text-[10px] text-white/35">
        添加微信时，请简要说明想讨论的项目或问题。
      </div>
    </div>
  )
}
