'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClassicDemo } from '@/data/classic-demos'
import { CATEGORY_LABELS } from '@/data/classic-demos'
import { EngineBadge } from './EngineBadge'

// 经典回放 LLM 重组版（川哥 5/30 钦定）：
// - 每个 stage 触发一次 SSE 调用 → /api/chat/replay-stream
// - DeepSeek 基于固定骨架 (output_md) 重新组织语言，每次访问不同
// - 流式 token 实时渲染（取代原打字机模拟）
// - 当前 stage 流完自动推进到下一 stage
// - 失败时 fallback 用 output_md 原文（前端无感）
// - 快进按钮 = 中止当前 fetch + 直接显示骨架原文

interface ReplayTimelineProps {
  demo: ClassicDemo
  onClose?: () => void
}

interface StageState {
  text: string
  status: 'pending' | 'streaming' | 'done' | 'error'
  fallback?: boolean
}

export function ReplayTimeline({ demo, onClose }: ReplayTimelineProps) {
  const [currentStage, setCurrentStage] = useState(0)
  const [stageStates, setStageStates] = useState<StageState[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const totalStages = demo.routing.length
  const isComplete = currentStage >= totalStages

  // demo 切换：reset + 启动第 0 stage
  useEffect(() => {
    setCurrentStage(0)
    setStageStates(
      demo.routing.map(() => ({ text: '', status: 'pending' as const })),
    )
    // 中断上一个 demo 的 fetch
    abortRef.current?.abort()
    abortRef.current = null
  }, [demo.id, demo.routing])

  // 推进到下一个 stage（流完或快进时调用）
  const advance = useCallback(() => {
    setCurrentStage((c) => c + 1)
  }, [])

  // 流式调用 replay-stream，逐 token push 到对应 stage
  const streamStage = useCallback(
    async (stageIdx: number) => {
      const step = demo.routing[stageIdx]
      if (!step) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      // 标记 streaming + 清空 text
      setStageStates((prev) => {
        const next = [...prev]
        next[stageIdx] = { text: '', status: 'streaming' }
        return next
      })

      try {
        const resp = await fetch('/api/chat/replay-stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ demo_id: demo.id, stage_idx: stageIdx }),
          signal: controller.signal,
        })

        if (!resp.ok || !resp.body) {
          throw new Error(`http_${resp.status}`)
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        let isFallback = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue

          buffer += decoder.decode(value, { stream: true })

          let nlIdx = buffer.indexOf('\n\n')
          while (nlIdx >= 0) {
            const chunk = buffer.slice(0, nlIdx)
            buffer = buffer.slice(nlIdx + 2)

            const eventLine = chunk.split('\n').find((l) => l.startsWith('event:'))
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'))
            if (!dataLine) {
              nlIdx = buffer.indexOf('\n\n')
              continue
            }

            const event = eventLine?.slice(6).trim() ?? ''
            const dataRaw = dataLine.slice(5).trim()
            let data: { delta?: string } = {}
            try {
              data = JSON.parse(dataRaw)
            } catch {
              // ignore parse error
            }

            if (event === 'token' && typeof data.delta === 'string') {
              setStageStates((prev) => {
                const next = [...prev]
                const cur = next[stageIdx]
                if (cur) next[stageIdx] = { ...cur, text: cur.text + data.delta }
                return next
              })
            } else if (event === 'fallback' && typeof data.delta === 'string') {
              isFallback = true
              setStageStates((prev) => {
                const next = [...prev]
                next[stageIdx] = { text: data.delta ?? '', status: 'streaming', fallback: true }
                return next
              })
            } else if (event === 'end') {
              // 流结束
            }

            nlIdx = buffer.indexOf('\n\n')
          }
        }

        // 流正常结束，标记 done + 自动推进
        setStageStates((prev) => {
          const next = [...prev]
          const cur = next[stageIdx]
          if (cur) next[stageIdx] = { ...cur, status: 'done', fallback: isFallback }
          return next
        })
        // 0.5s 过渡推进
        setTimeout(advance, 500)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // 网络/服务异常 → 直接用 output_md 兜底
        setStageStates((prev) => {
          const next = [...prev]
          next[stageIdx] = { text: step.output_md, status: 'done', fallback: true }
          return next
        })
        setTimeout(advance, 500)
      }
    },
    [demo.id, demo.routing, advance],
  )

  // currentStage 推进时启动 stream
  useEffect(() => {
    if (currentStage < 0 || currentStage >= totalStages) return
    const state = stageStates[currentStage]
    if (!state || state.status !== 'pending') return
    void streamStage(currentStage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, totalStages, stageStates.length])

  // 卸载时中断
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  // 快进：中断当前 stream，把当前 stage 立刻填充 output_md，推进
  const skip = useCallback(() => {
    abortRef.current?.abort()
    setStageStates((prev) => {
      const next = [...prev]
      const cur = next[currentStage]
      const step = demo.routing[currentStage]
      if (cur && step && cur.status !== 'done') {
        next[currentStage] = { text: step.output_md, status: 'done', fallback: true }
      }
      return next
    })
    advance()
  }, [currentStage, demo.routing, advance])

  return (
    <section className="rounded-lg border border-[#7FE5FF]/30 bg-[#7FE5FF]/[0.03] p-5">
      {/* 头部 */}
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/85">
              {CATEGORY_LABELS[demo.category]} · 决策示例
            </span>
            <span className="font-mono text-[10px] text-white/35">
              AI 根据整理稿生成
            </span>
          </div>
          <h3 className="text-lg font-medium leading-snug text-white">
            {demo.question}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isComplete && (
            <button
              type="button"
              onClick={skip}
              className="rounded border border-white/15 bg-black/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/65 transition hover:border-[#7FE5FF]/40 hover:text-[#7FE5FF]"
            >
              查看本步整理稿 ⏭
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-white/15 bg-black/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/65 transition hover:border-white/40 hover:text-white"
            >
              关闭 ✕
            </button>
          )}
        </div>
      </header>

      {/* 进度条 */}
      <div className="mb-5">
        <div className="mb-1 flex items-baseline justify-between text-[10px] font-mono">
          <span className="text-white/55">
            示例步骤 {Math.min(currentStage + 1, totalStages)} / {totalStages}
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full bg-gradient-to-r from-[#7FE5FF]/85 to-[#A78BFA]/85 transition-all duration-500"
            style={{
              width: `${(Math.min(currentStage + 1, totalStages) / totalStages) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* 垂直 timeline */}
      <ol className="relative space-y-4 border-l border-white/[0.08] pl-5">
        {demo.routing.map((step, idx) => {
          const isCurrent = idx === currentStage
          const isDone = idx < currentStage
          const isPending = idx > currentStage
          const state = stageStates[idx]
          const displayText = state?.text ?? ''

          return (
            <li key={idx} className="relative">
              {/* timeline 圆点 */}
              <div
                className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 ${
                  isDone
                    ? 'border-[#7FE5FF] bg-[#7FE5FF]'
                    : isCurrent
                      ? 'border-[#7FE5FF] bg-black animate-pulse'
                      : 'border-white/20 bg-black'
                }`}
                aria-hidden
              />

              <div
                className={`rounded border p-3.5 transition ${
                  isPending
                    ? 'border-white/[0.06] bg-white/[0.01] opacity-40'
                    : 'border-white/10 bg-black/30'
                }`}
              >
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <EngineBadge engine={step.engine} stage={step.stage} compact />
                  <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-white/40">
                    {state?.status === 'streaming' && (
                      <span className="text-[#7FE5FF]/80">● 正在生成示例</span>
                    )}
                    {state?.fallback && state?.status === 'done' && (
                      <span className="text-white/45">整理稿</span>
                    )}
                  </span>
                </div>

                {(isDone || isCurrent) && (
                  <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-white/85">
                    {displayText}
                    {isCurrent && state?.status === 'streaming' && (
                      <span className="ml-0.5 inline-block h-[1em] w-[2px] -translate-y-[2px] animate-pulse bg-[#7FE5FF]/85 align-middle" />
                    )}
                  </div>
                )}

                {isPending && (
                  <div className="text-[11px] font-mono italic text-white/30">
                    等待上一步示例显示…
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* 完成后底部 CTA */}
      {isComplete && (
        <div className="mt-5 rounded border border-[#7FE5FF]/30 bg-[#7FE5FF]/[0.06] p-4">
          <p className="text-[13px] leading-relaxed text-white/85">
            本例已展示完毕。可以选择其他示例，也可以直接提问。
          </p>
          <div className="mt-2 text-[11px] text-white/55">
            标签表示分析、复核、实现与判断等环节，不代表本次展示调用了多个模型。
          </div>
        </div>
      )}
    </section>
  )
}
