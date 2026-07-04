import { NextResponse } from 'next/server'
import {
  consumeBudget,
  getDailyBudget,
  getDailyRemainingCents,
  isBudgetExhausted,
  willExceedBudget,
} from '@/lib/chat/budget'
import {
  banIp,
  getUsageWindows,
  isIpBlacklisted,
  recordUsageAndCheck,
  SUSTAINED_THRESHOLD_CENTS,
} from '@/lib/chat/blacklist'
import {
  estimateCost,
  openGeminiProxyStream,
  streamGeminiTokens,
  type ChatMessage,
} from '@/lib/chat/gemini-proxy'
import { hashIp, resolveClientIp } from '@/lib/chat/quota'
import { CLASSIC_DEMOS } from '@/data/classic-demos'
import { buildReplayPrompt } from '@/lib/chat/replay-prompt'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ReplayPayload {
  demo_id?: unknown
  stage_idx?: unknown
}

function sendSse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  const encoder = new TextEncoder()
  const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  controller.enqueue(encoder.encode(text))
}

/**
 * 经典回放 LLM 重组 endpoint。
 *
 * 接收：{ demo_id, stage_idx }
 * 返回：SSE 流（event: token + event: end + event: error）
 *
 * 与 /api/chat/stream 区别：
 * - 不消费 chat_quota（这是回放观看，不是自由对话）
 * - 但走全站预算 + IP burst/sustained 监控（防爬）
 * - 固定走 DeepSeek minimal（便宜，因为骨架信息已给足）
 * - 失败时返回 fallback event，前端用 output_md 原文兜底
 */
export async function POST(req: Request): Promise<Response> {
  let payload: ReplayPayload
  try {
    payload = (await req.json()) as ReplayPayload
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const demoId = typeof payload.demo_id === 'string' ? payload.demo_id.trim() : ''
  const stageIdx = typeof payload.stage_idx === 'number' ? payload.stage_idx : -1

  if (!demoId || stageIdx < 0) {
    return NextResponse.json({ error: 'invalid_params' }, { status: 400 })
  }

  const demo = CLASSIC_DEMOS.find((d) => d.id === demoId)
  if (!demo) {
    return NextResponse.json({ error: 'demo_not_found' }, { status: 404 })
  }

  const step = demo.routing[stageIdx]
  if (!step) {
    return NextResponse.json({ error: 'stage_not_found' }, { status: 404 })
  }

  // IP 限流（与 /api/chat/stream 同一套监控）
  const ip = resolveClientIp(req.headers)
  const ipHash = hashIp(ip)
  const now = Date.now()

  const blacklistStatus = isIpBlacklisted(ipHash, now)
  if (blacklistStatus.blacklisted) {
    return NextResponse.json(
      { error: 'blacklisted', reason: blacklistStatus.reason ?? 'unknown' },
      { status: 403 },
    )
  }

  const currentBudget = getDailyBudget(now)
  if (isBudgetExhausted(currentBudget)) {
    // 预算耗尽时不报错，发 fallback 让前端走原文兜底（保证回放永远可用）
    return streamFallback(step.output_md, 'budget_exhausted')
  }

  // 经典回放固定走 DeepSeek + minimal thinking（骨架已给，重组任务简单 + 便宜）
  // 估算成本 ~1c/stage call。每个完整 demo (4 stage) = 4c，5 个 demo 全跑 = 20c
  const profile = {
    provider: 'deepseek' as const,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    thinkingEffort: 'minimal' as const,
    maxTokens: 4096,
  }
  const estimatedCost = estimateCost(profile.model, profile.thinkingEffort)

  if (willExceedBudget(currentBudget, estimatedCost)) {
    return streamFallback(step.output_md, 'budget_would_exceed')
  }

  const preUsage = getUsageWindows(ipHash, now)
  if (preUsage.sustained1hCents > SUSTAINED_THRESHOLD_CENTS) {
    banIp(ipHash, 'sustained_1h', now)
    return streamFallback(step.output_md, 'rate_limited')
  }

  // 构造 user message（骨架重组 prompt）
  const prompt = buildReplayPrompt({
    engine: step.engine,
    stage: step.stage,
    question: demo.question,
    output_md: step.output_md,
  })

  const messages: ChatMessage[] = [{ role: 'user', content: prompt }]

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        sendSse(controller, 'start', {
          demo_id: demoId,
          stage_idx: stageIdx,
          stage: step.stage,
          engine: step.engine,
        })

        const proxyResponse = await openGeminiProxyStream(messages, profile)

        let totalChars = 0
        for await (const delta of streamGeminiTokens(proxyResponse)) {
          totalChars += delta.length
          sendSse(controller, 'token', { delta })
        }

        // 成本记账（即使流式中也只在末尾扣，避免半途失败重复扣）
        consumeBudget(estimatedCost)
        const usage = recordUsageAndCheck(ipHash, estimatedCost)
        if (usage.burstExceeded || usage.sustainedExceeded) {
          banIp(ipHash, usage.burstExceeded ? 'burst_10min' : 'sustained_1h')
        }

        sendSse(controller, 'end', { total_chars: totalChars })
      } catch (error) {
        // 失败时降级：把原文 output_md 一次性塞回去
        const reason = error instanceof Error ? error.message : String(error)
        sendSse(controller, 'fallback', {
          delta: step.output_md,
          reason: `llm_failed: ${reason.slice(0, 120)}`,
        })
        sendSse(controller, 'end', { fallback: true })
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

/**
 * 降级路径：预算耗尽 / 限流时，把骨架原文当作 token 流送一遍，
 * 保证回放永远可用（这是「零成本观摩」的产品承诺）。
 */
function streamFallback(originalText: string, reason: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sendSse(controller, 'fallback', { delta: originalText, reason })
      sendSse(controller, 'end', { fallback: true })
      controller.close()
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

function getDailyRemainingCentsLocal(): number {
  return getDailyRemainingCents(getDailyBudget(Date.now()))
}
void getDailyRemainingCentsLocal // 防 unused（用于未来扩展）
