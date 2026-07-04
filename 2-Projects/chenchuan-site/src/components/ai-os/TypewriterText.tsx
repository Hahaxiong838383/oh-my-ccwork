'use client'

import { useEffect, useRef, useState } from 'react'

// 打字机文字渲染。按 charsPerSecond 速度逐字渲染 text。
// onDone 在完成时回调（用于 stage 间过渡）。
// 支持 skip：用户点击跳过动画直接显示全文。

interface TypewriterTextProps {
  text: string
  charsPerSecond?: number // 默认 80 chars/s（中文阅读舒适速度）
  startDelayMs?: number
  onDone?: () => void
  skipToken?: number // 改变这个 prop 立刻跳到全文
  className?: string
}

export function TypewriterText({
  text,
  charsPerSecond = 80,
  startDelayMs = 0,
  onDone,
  skipToken = 0,
  className,
}: TypewriterTextProps) {
  const [displayed, setDisplayed] = useState('')
  const doneRef = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    doneRef.current = false
    setDisplayed('')

    const intervalMs = Math.max(8, Math.floor(1000 / charsPerSecond))
    const charsPerTick = Math.max(1, Math.ceil(charsPerSecond * intervalMs / 1000))
    let idx = 0
    let interval: ReturnType<typeof setInterval> | null = null

    const startTimer = setTimeout(() => {
      interval = setInterval(() => {
        idx = Math.min(text.length, idx + charsPerTick)
        setDisplayed(text.slice(0, idx))
        if (idx >= text.length) {
          if (interval) clearInterval(interval)
          if (!doneRef.current) {
            doneRef.current = true
            onDoneRef.current?.()
          }
        }
      }, intervalMs)
    }, startDelayMs)

    return () => {
      clearTimeout(startTimer)
      if (interval) clearInterval(interval)
    }
  }, [text, charsPerSecond, startDelayMs])

  // skipToken 变化 → 立刻显示全文
  useEffect(() => {
    if (skipToken > 0) {
      setDisplayed(text)
      if (!doneRef.current) {
        doneRef.current = true
        onDoneRef.current?.()
      }
    }
  }, [skipToken, text])

  return <span className={className}>{displayed}</span>
}
