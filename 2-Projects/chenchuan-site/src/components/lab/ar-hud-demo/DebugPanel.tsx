'use client'

import { useEffect, useState } from 'react'
import { interactionStore } from '@/lib/ar-hud/interaction-store'

interface DebugFrame {
  gazeX: number | null
  gazeY: number | null
  leftHandLabel: string
  rightHandLabel: string
  brow: number
  smile: number
  mouth: number
}

const INITIAL_DEBUG: DebugFrame = {
  gazeX: null,
  gazeY: null,
  leftHandLabel: 'left: none',
  rightHandLabel: 'right: none',
  brow: 0,
  smile: 0,
  mouth: 0,
}

function formatNumber(value: number): string {
  return value.toFixed(2)
}

// DebugPanel 自订阅 InteractionStore，但**降频到 8Hz**（每 125ms 才 setState 一次），
// 避免每帧 React render（debug 面板不需要 30fps 刷新）。
export function DebugPanel() {
  const [visible, setVisible] = useState(true)
  const [debug, setDebug] = useState<DebugFrame>(INITIAL_DEBUG)

  useEffect(() => {
    let lastUpdate = 0
    const SAMPLE_INTERVAL_MS = 125

    const unsub = interactionStore.subscribe(() => {
      const now = performance.now()
      if (now - lastUpdate < SAMPLE_INTERVAL_MS) return
      lastUpdate = now

      const frame = interactionStore.read()
      const left = frame.pinch.find((p) => p.hand === 'left')
      const right = frame.pinch.find((p) => p.hand === 'right')

      setDebug({
        gazeX: frame.gaze?.x ?? null,
        gazeY: frame.gaze?.y ?? null,
        leftHandLabel: left ? `left: ${left.isPinching ? 'pinch' : 'open'}` : 'left: none',
        rightHandLabel: right ? `right: ${right.isPinching ? 'pinch' : 'open'}` : 'right: none',
        brow: frame.face.browFurrow,
        smile: frame.face.smile,
        mouth: frame.face.mouthOpen,
      })
    })

    return unsub
  }, [])

  return (
    <div className="pointer-events-auto absolute right-4 top-4 z-20 w-[min(92vw,640px)] font-mono text-xs text-white">
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        className="mb-2 rounded border border-white/30 bg-black/60 px-3 py-1 text-[11px] tracking-wide hover:bg-black/80"
      >
        {visible ? '隐藏调试面板' : '显示调试面板'}
      </button>

      {visible && (
        <div className="grid grid-cols-1 gap-2 rounded border border-white/20 bg-black/65 p-3 md:grid-cols-3">
          <section className="space-y-1">
            <h3 className="text-[11px] uppercase tracking-wide text-white/65">gaze</h3>
            <p>x: {debug.gazeX !== null ? Math.round(debug.gazeX) : 'null'}</p>
            <p>y: {debug.gazeY !== null ? Math.round(debug.gazeY) : 'null'}</p>
          </section>

          <section className="space-y-1">
            <h3 className="text-[11px] uppercase tracking-wide text-white/65">hands</h3>
            <p>{debug.leftHandLabel}</p>
            <p>{debug.rightHandLabel}</p>
          </section>

          <section className="space-y-1">
            <h3 className="text-[11px] uppercase tracking-wide text-white/65">face</h3>
            <p>brow: {formatNumber(debug.brow)}</p>
            <p>smile: {formatNumber(debug.smile)}</p>
            <p>mouth: {formatNumber(debug.mouth)}</p>
          </section>
        </div>
      )}
    </div>
  )
}
