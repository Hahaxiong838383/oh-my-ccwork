import { NextResponse } from 'next/server'
import {
  consumeBudget,
  getDailyBudget,
  getDailyRemainingCents,
  isBudgetExhausted,
  type BudgetAlertLevel,
  willExceedBudget,
} from '@/lib/chat/budget'
import {
  banIp,
  getUsageWindows,
  isIpBlacklisted,
  recordUsageAndCheck,
  SUSTAINED_THRESHOLD_CENTS,
} from '@/lib/chat/blacklist'
import { sendChatAlert } from '@/lib/chat/feishu-alert'
import {
  estimateCost,
  openGeminiProxyStream,
  pickModelProfile,
  streamGeminiTokens,
  type ChatMessage,
} from '@/lib/chat/gemini-proxy'
import { consumeQuota, getQuotaStatus, hashIp, resolveClientIp } from '@/lib/chat/quota'
import { getStrategicMirrorPrompt, ROLE_HANDOFF_SUFFIX } from '@/lib/chat/system-prompt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface StreamPayload {
  messages?: unknown
  cookie_id?: unknown
}

function sendSse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  const encoder = new TextEncoder()
  const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  controller.enqueue(encoder.encode(text))
}

function parseMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null
  const parsed: ChatMessage[] = []

  for (const item of input) {
    if (!item || typeof item !== 'object') return null
    const role = (item as { role?: unknown }).role
    const content = (item as { content?: unknown }).content
    if ((role !== 'system' && role !== 'user' && role !== 'assistant') || typeof content !== 'string') {
      return null
    }
    parsed.push({ role, content })
  }

  return parsed
}

function alertLevelToType(level: BudgetAlertLevel): 'budget_50' | 'budget_80' | 'budget_100' {
  if (level === 50) return 'budget_50'
  if (level === 80) return 'budget_80'
  return 'budget_100'
}

export async function POST(req: Request): Promise<Response> {
  let payload: StreamPayload
  try {
    payload = (await req.json()) as StreamPayload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const cookieId = typeof payload.cookie_id === 'string' ? payload.cookie_id.trim() : ''
  if (!cookieId) {
    return NextResponse.json({ error: 'missing_cookie_id' }, { status: 400 })
  }

  const messages = parseMessages(payload.messages)
  if (!messages || messages.length === 0) {
    return NextResponse.json({ error: 'invalid_messages' }, { status: 400 })
  }

  const ip = resolveClientIp(req.headers)
  const ipHash = hashIp(ip)
  const now = Date.now()

  const blacklistStatus = isIpBlacklisted(ipHash, now)
  if (blacklistStatus.blacklisted) {
    return NextResponse.json(
      {
        error: 'blacklisted',
        reason: blacklistStatus.reason ?? 'unknown',
        expires_at: blacklistStatus.expiresAt ?? null,
      },
      { status: 403 },
    )
  }

  const currentBudget = getDailyBudget(now)
  if (isBudgetExhausted(currentBudget)) {
    return NextResponse.json(
      {
        error: 'budget_exhausted',
        daily_cents_remaining: getDailyRemainingCents(currentBudget),
      },
      { status: 503 },
    )
  }

  const profile = pickModelProfile(messages)
  const estimatedCost = estimateCost(profile.model, profile.thinkingEffort)

  // ★ 注入「陈川的战略镜像」system prompt（gemini 对抗审 P0-1 钦定灵魂）
  // 不能直接传 user messages 给 Gemini，否则它会以 "AI 助手"姿态回答技术琐事，
  // 方案 B 的"产品 leader 战略镜像"定位崩塌。
  const messagesWithSystem: ChatMessage[] = [
    { role: 'system', content: getStrategicMirrorPrompt() },
    ...messages,
  ]
  if (willExceedBudget(currentBudget, estimatedCost)) {
    return NextResponse.json(
      {
        error: 'budget_exhausted',
        daily_cents_remaining: getDailyRemainingCents(currentBudget),
      },
      { status: 503 },
    )
  }

  const quota = getQuotaStatus(cookieId, ipHash)
  if (quota.remaining <= 0) {
    return NextResponse.json({ error: 'quota_exceeded' }, { status: 403 })
  }

  const preUsage = getUsageWindows(ipHash, now)
  if (preUsage.sustained1hCents > SUSTAINED_THRESHOLD_CENTS) {
    const expiresAt = banIp(ipHash, 'sustained_1h', now)
    await sendChatAlert({
      type: 'sustained_1h',
      title: '🤖 ai-os/chat 异常流量预警（1h）',
      summary: '过去 1 小时该 IP 消耗超过 ¥1.5，已自动拉黑 24h。',
      fields: {
        ip_hash: ipHash,
        sustained_1h_cents: preUsage.sustained1hCents,
        expires_at: expiresAt,
      },
    })
    return NextResponse.json({ error: 'blacklisted', reason: 'sustained_1h' }, { status: 403 })
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 简单 / 复杂问题都标 gemini engine（统一外部 LLM 视觉，紫色）
        // 通过 thinkingEffort 区分 label：high 档 = 深度推理；其余 = 快速回应。
        // 用 effort 而非 provider 判断，确保 DeepSeek fallback 时 label 也准。
        sendSse(controller, 'routing', {
          stage: 'thinking',
          engine: 'gemini',
          label:
            profile.thinkingEffort === 'high'
              ? '深度推理 · 战略问答档'
              : '快速回应 · 简单问答档',
        })

        const proxyResponse = await openGeminiProxyStream(messagesWithSystem, profile)
        for await (const delta of streamGeminiTokens(proxyResponse, profile.provider === 'minimax')) {
          sendSse(controller, 'token', { delta })
        }

        sendSse(controller, 'routing', { stage: 'done' })

        const updatedQuota = consumeQuota(cookieId, ipHash)

        // ★ 第 3 轮回答末尾自动追加"角色转场"话术（gemini P1-1 钦定）
        // 不是硬切断，是 AI 主动说"我不够"，引导加微信。比"额度用完"友好 10 倍。
        if (updatedQuota.count >= 3) {
          for (const chunk of ROLE_HANDOFF_SUFFIX.split('\n')) {
            sendSse(controller, 'token', { delta: chunk + '\n' })
          }
        }

        const budgetResult = consumeBudget(estimatedCost)

        for (const level of budgetResult.triggeredAlerts) {
          await sendChatAlert({
            type: alertLevelToType(level),
            title: `🤖 ai-os/chat 预算预警（${level}%）`,
            summary: `今日预算已达到 ${level}% 阈值。`,
            fields: {
              date: budgetResult.budget.date,
              cents_used: budgetResult.budget.cents_used,
              cents_cap: budgetResult.budget.cents_cap,
              remaining_cents: getDailyRemainingCents(budgetResult.budget),
            },
          })
        }

        const usageResult = recordUsageAndCheck(ipHash, estimatedCost)
        if (usageResult.burstExceeded) {
          const expiresAt = banIp(ipHash, 'burst_10min')
          await sendChatAlert({
            type: 'burst_10min',
            title: '🤖 ai-os/chat 异常流量预警（10min burst）',
            summary: '10 分钟内消耗超过 ¥2，已自动拉黑 24h。',
            fields: {
              ip_hash: ipHash,
              burst_10min_cents: usageResult.burst10MinCents,
              sustained_1h_cents: usageResult.sustained1hCents,
              expires_at: expiresAt,
            },
          })
        } else if (usageResult.sustainedExceeded) {
          const expiresAt = banIp(ipHash, 'sustained_1h')
          await sendChatAlert({
            type: 'sustained_1h',
            title: '🤖 ai-os/chat 异常流量预警（1h）',
            summary: '1 小时累计消耗超过 ¥1.5，已自动拉黑 24h。',
            fields: {
              ip_hash: ipHash,
              sustained_1h_cents: usageResult.sustained1hCents,
              expires_at: expiresAt,
            },
          })
        }

        sendSse(controller, 'end', {
          quota_remaining: updatedQuota.remaining,
          is_3rd: updatedQuota.count === 3,
        })
      } catch (error) {
        sendSse(controller, 'error', {
          error: 'stream_failed',
          reason: error instanceof Error ? error.message : String(error),
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
