import 'server-only'

// 多 Provider LLM 路由：
// - 简单聊天（短问答 / 普通深度）→ DeepSeek-v4-flash（便宜 + 快）
// - 复杂问题（长文 / 战略关键词）→ MiniMax-M3（reasoning_effort=none，客户端过滤 <think>）
//   2026-07-01 从 Gemini 3.1 flash-lite 切换到 MiniMax-M3：韩国生产 TTFT ~1.4s，
//   M 系列强制带 <think> 思维链（none 档极短），标签在 content 流里，由 streamGeminiTokens 过滤。
//
// 三家都是 OpenAI 兼容 SSE，stream 解析逻辑通用。
// 凭据走 env：DEEPSEEK_* / MINIMAX_*（GEMINI_PROXY_* 保留兼容，作二级降级路径）。
// 文件名保留 gemini-proxy.ts 防大面积 import 重写，实际职责是 llm-router。

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export type ThinkingEffort = 'minimal' | 'medium' | 'high'
export type LLMProvider = 'deepseek' | 'gemini' | 'minimax'

export interface ModelProfile {
  provider: LLMProvider
  model: string
  thinkingEffort: ThinkingEffort
  maxTokens: number
}

const LONG_TEXT_THRESHOLD = 120
const SHORT_TEXT_THRESHOLD = 20
const STRATEGIC_KEYWORDS = [
  '战略',
  '战略镜像',
  '商业模式',
  '组织',
  '路线图',
  '市场',
  '增长',
  '融资',
  '竞争',
  '架构',
]

export function pickModelProfile(messages: ChatMessage[]): ModelProfile {
  const latestUser = [...messages].reverse().find((m) => m.role === 'user')
  const text = latestUser?.content?.trim() ?? ''
  const length = text.length
  const hitStrategicKeyword = STRATEGIC_KEYWORDS.some((keyword) => text.includes(keyword))

  const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
  const minimaxConfigured = Boolean(process.env.MINIMAX_BASE_URL)

  // 复杂问题：长文 / 战略关键词 → MiniMax-M3（reasoning_effort=none，最快，客户端过滤 <think>）
  // MiniMax 未配时降级到 DeepSeek high 档（保证体验不挂错误页）
  if (length >= LONG_TEXT_THRESHOLD || hitStrategicKeyword) {
    if (minimaxConfigured) {
      return {
        provider: 'minimax',
        model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
        thinkingEffort: 'high', // 仅作 label 语义标记；实际 reasoning_effort=none 见 openGeminiProxyStream
        maxTokens: 8192, // 控制复杂回复长度，避免 M3 超长长篇（2026-07-01 从 65535 下调）
      }
    }
    return {
      provider: 'deepseek',
      model: deepseekModel,
      thinkingEffort: 'high',
      maxTokens: 16384,
    }
  }

  // 简单聊天 / 普通问答 → DeepSeek（川哥钦定的主力，便宜快）
  return {
    provider: 'deepseek',
    model: deepseekModel,
    thinkingEffort: length < SHORT_TEXT_THRESHOLD ? 'minimal' : 'medium',
    maxTokens: length < SHORT_TEXT_THRESHOLD ? 4096 : 16384,
  }
}

export function estimateCost(model: string, thinkingEffort: ThinkingEffort): number {
  // DeepSeek 比 Gemini Flash 便宜约 3-5x（按官方定价反推），保守估 1 cent/轮
  if (model.startsWith('deepseek')) return 1
  if (/^minimax/i.test(model)) return 2 // MiniMax-M3 reasoning_effort=none，保守估 2 cent/轮
  if (model.includes('flash-lite')) return 2
  if (model.includes('flash') && thinkingEffort === 'high') return 15
  return 5
}

interface ProviderConfig {
  baseUrl: string
  apiKey: string
}

function getProviderConfig(provider: LLMProvider): ProviderConfig {
  if (provider === 'deepseek') {
    const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey) throw new Error('missing_deepseek_api_key')
    return { baseUrl, apiKey }
  }
  if (provider === 'minimax') {
    const baseUrl = process.env.MINIMAX_BASE_URL
    const apiKey = process.env.MINIMAX_API_KEY
    if (!baseUrl) throw new Error('missing_minimax_base_url')
    if (!apiKey) throw new Error('missing_minimax_api_key')
    return { baseUrl, apiKey }
  }
  // gemini（保留兼容）
  const baseUrl = process.env.GEMINI_PROXY_BASE_URL
  const apiKey = process.env.GEMINI_PROXY_API_KEY
  if (!baseUrl) throw new Error('missing_gemini_proxy_base_url')
  return { baseUrl, apiKey: apiKey ?? '' }
}

// 多 provider 透传 SSE。命名保留 openGeminiProxyStream 防大面积 import 重写。
// 实际按 profile.provider 路由到 DeepSeek / MiniMax / Gemini Proxy。
export async function openGeminiProxyStream(
  messages: ChatMessage[],
  profile: ModelProfile,
): Promise<Response> {
  const config = getProviderConfig(profile.provider)

  const body: Record<string, unknown> = {
    model: profile.model,
    messages,
    stream: true,
    max_tokens: profile.maxTokens,
  }
  // Gemini proxy 支持 thinking_effort（OpenAI 兼容扩展）；
  // MiniMax 支持 reasoning_effort，选 none 关思维链最快（<think> 标签仍出现，由客户端过滤）；
  // DeepSeek 不需要。
  if (profile.provider === 'gemini') {
    body.thinking_effort = profile.thinkingEffort
  } else if (profile.provider === 'minimax') {
    body.reasoning_effort = 'none'
  }

  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    let body = ''
    try {
      body = await response.text()
    } catch {
      body = ''
    }
    throw new Error(`${profile.provider}_http_${response.status}${body ? `:${body.slice(0, 200)}` : ''}`)
  }

  if (!response.body) {
    throw new Error(`${profile.provider}_empty_body`)
  }

  return response
}

// MiniMax M 系列把思维链放在 content 的 <think>...</think> 里（reasoning_effort=none 时极短但标签仍在）。
// 流式过滤：标签可能被 SSE delta 切成两半（如一片以 "<thi" 结尾），用 carry 缓存可能的半截标签。
function makeThinkStripper(): (delta: string) => string {
  let inThink = false
  let carry = ''
  const OPEN = '<think>'
  const CLOSE = '</think>'
  // 返回 s 末尾可能是 tag 前缀的部分（如 s 以 "</thi" 结尾），需留到下一片再判断
  const keepPartial = (s: string, tag: string): string => {
    const max = Math.min(s.length, tag.length - 1)
    for (let n = max; n > 0; n -= 1) {
      if (tag.startsWith(s.slice(s.length - n))) return s.slice(s.length - n)
    }
    return ''
  }
  return (delta: string): string => {
    let s = carry + delta
    carry = ''
    let out = ''
    while (s.length) {
      if (inThink) {
        const i = s.indexOf(CLOSE)
        if (i === -1) {
          carry = keepPartial(s, CLOSE)
          break
        }
        s = s.slice(i + CLOSE.length)
        inThink = false
      } else {
        const i = s.indexOf(OPEN)
        if (i === -1) {
          const partial = keepPartial(s, OPEN)
          out += partial ? s.slice(0, s.length - partial.length) : s
          carry = partial
          break
        }
        out += s.slice(0, i)
        s = s.slice(i + OPEN.length)
        inThink = true
      }
    }
    return out
  }
}

export async function* streamGeminiTokens(
  response: Response,
  filterThink = false,
): AsyncGenerator<string> {
  if (!response.body) return

  const strip = filterThink ? makeThinkStripper() : null
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = response.body.getReader()

  const emit = (delta: string): string => (strip ? strip(delta) : delta)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      buffer += decoder.decode(value, { stream: true })

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)

        if (line.startsWith('data:')) {
          const raw = line.slice(5).trim()
          if (!raw) {
            newlineIndex = buffer.indexOf('\n')
            continue
          }
          if (raw === '[DONE]') {
            return
          }

          try {
            const payload = JSON.parse(raw) as {
              choices?: Array<{
                delta?: {
                  content?: string
                }
              }>
            }
            const delta = payload.choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta.length > 0) {
              const out = emit(delta)
              if (out) yield out
            }
          } catch {
            // 忽略非 JSON 数据行
          }
        }

        newlineIndex = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }

  const remaining = buffer.trim()
  if (remaining.startsWith('data:')) {
    const raw = remaining.slice(5).trim()
    if (raw && raw !== '[DONE]') {
      try {
        const payload = JSON.parse(raw) as {
          choices?: Array<{
            delta?: {
              content?: string
            }
          }>
        }
        const delta = payload.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          const out = emit(delta)
          if (out) yield out
        }
      } catch {
        // ignore
      }
    }
  }
}
