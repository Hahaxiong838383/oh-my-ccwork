'use client'

import { useEffect, useRef } from 'react'
import { loadMediaPipeLandmarkers } from '@/lib/ar-hud/mediapipe-loader'

export type Point = { x: number; y: number; z: number }
export type GazeData = { x: number; y: number } | null
export type HandData = {
  landmarks: Point[]
  pinch: boolean
  hand: 'left' | 'right'
}
export type FaceData = {
  browFurrow: number
  smile: number
  mouthOpen: number
}

interface MediaPipeStageProps {
  stream: MediaStream
  onGaze: (gaze: GazeData) => void
  onHands: (hands: HandData[]) => void
  onFace: (face: FaceData) => void
}

const LEFT_IRIS_INDEXES = [468, 469, 470, 471, 472]
const RIGHT_IRIS_INDEXES = [473, 474, 475, 476, 477]

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

function avgLandmark(landmarks: any[], indexes: number[]): { x: number; y: number } | null {
  if (!landmarks?.length) return null

  let sumX = 0
  let sumY = 0
  let count = 0

  for (const index of indexes) {
    const point = landmarks[index]
    if (!point) continue
    sumX += point.x
    sumY += point.y
    count += 1
  }

  if (!count) return null

  return {
    x: sumX / count,
    y: sumY / count,
  }
}

function getBlendshapeScore(result: any, key: string): number {
  const categories = result?.faceBlendshapes?.[0]?.categories as
    | Array<{ categoryName?: string; score?: number }>
    | undefined

  if (!categories?.length) return 0

  const item = categories.find((category) => category.categoryName === key)
  return clamp01(item?.score ?? 0)
}

// 2D 距离判定（不用 z 轴：web 端 z 是统计学先验估算的，不稳，容易让捏合在前后移动时跳变）
function pinchDistance2D(points: any[]): number {
  const thumbTip = points?.[4]
  const indexTip = points?.[8]
  if (!thumbTip || !indexTip) return Infinity
  const dx = thumbTip.x - indexTip.x
  const dy = thumbTip.y - indexTip.y
  return Math.sqrt(dx * dx + dy * dy)
}

// 迟滞阈值（hysteresis）：从未捏合 → 捏合需要更近的距离，
// 从已捏合 → 松开需要更远的距离。避免阈值边缘的 true/false 闪烁。
const PINCH_ENTER_THRESHOLD = 0.05
const PINCH_EXIT_THRESHOLD = 0.10

function nextPinchState(currentState: boolean, distance: number): boolean {
  if (currentState) {
    // 已捏合：直到距离明显拉大才视为松开
    return distance < PINCH_EXIT_THRESHOLD
  }
  // 未捏合：距离够小才触发
  return distance < PINCH_ENTER_THRESHOLD
}

export function MediaPipeStage({ stream, onGaze, onHands, onFace }: MediaPipeStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastLogAtRef = useRef(0)
  const lastTimestampRef = useRef(0)
  // 迟滞 pinch 状态跨帧持有
  const pinchStateRef = useRef<Record<'left' | 'right', boolean>>({ left: false, right: false })

  useEffect(() => {
    let cancelled = false
    let frameCallbackId: number | null = null
    let rafId: number | null = null
    let faceLandmarker: any = null
    let handLandmarker: any = null

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    const context = canvas.getContext('2d')

    const toPoint = (point: any): Point => ({
      x: point?.x ?? 0,
      y: point?.y ?? 0,
      z: point?.z ?? 0,
    })

    const runInference = (videoTimestampMs?: number) => {
      if (cancelled || !faceLandmarker || !handLandmarker) return
      // 严格 readyState：HAVE_ENOUGH_DATA = 4，保证 video 帧已解码
      if (video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return
      if (video.videoWidth === 0 || video.videoHeight === 0) return

      // MediaPipe VIDEO 模式要求 timestamp 严格单调递增。
      // 优先用 rVFC 提供的 video mediaTime（与帧绑定，最稳）；
      // fallback performance.now()；遇到 ≤ 上次值时强制 +1。
      let nowMs = videoTimestampMs ?? performance.now()
      if (nowMs <= lastTimestampRef.current) {
        nowMs = lastTimestampRef.current + 1
      }
      lastTimestampRef.current = nowMs

      let faceResult: any = null
      let handResult: any = null
      try {
        faceResult = faceLandmarker.detectForVideo(video, nowMs)
        handResult = handLandmarker.detectForVideo(video, nowMs)
      } catch (err) {
        // 单帧失败不炸循环。开发模式下 warn 出来便于排查（不是 error，避免 Next 误显示）
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.warn('[ar-hud-demo] detectForVideo skipped frame:', err)
        }
        return
      }

      const faceLandmarks = faceResult?.faceLandmarks?.[0]
      let gazeData: GazeData = null
      if (faceLandmarks?.length) {
        const leftIris = avgLandmark(faceLandmarks, LEFT_IRIS_INDEXES)
        const rightIris = avgLandmark(faceLandmarks, RIGHT_IRIS_INDEXES)

        if (leftIris && rightIris) {
          const eyeCenterX = (leftIris.x + rightIris.x) / 2
          const eyeCenterY = (leftIris.y + rightIris.y) / 2
          gazeData = {
            x: clampSigned((eyeCenterX - 0.5) * 2),
            y: clampSigned((eyeCenterY - 0.5) * 2),
          }
        }
      }
      onGaze(gazeData)

      const hands: HandData[] = (handResult?.landmarks ?? []).map((landmarks: any[], index: number) => {
        const handednessLabel =
          handResult?.handedness?.[index]?.[0]?.categoryName?.toLowerCase() ?? 'right'
        const hand: 'left' | 'right' = handednessLabel === 'left' ? 'left' : 'right'

        // 迟滞判定：用 2D 距离 + 进入/退出双阈值，避免阈值边缘的高频闪烁。
        const dist = pinchDistance2D(landmarks)
        const wasPinching = pinchStateRef.current[hand]
        const nowPinching = nextPinchState(wasPinching, dist)
        pinchStateRef.current[hand] = nowPinching

        return {
          landmarks: landmarks.map(toPoint),
          pinch: nowPinching,
          hand,
        }
      })
      // hand 离场时清理 pinch 状态，避免下次进场时被卡在 true
      const presentHands = new Set(hands.map((h) => h.hand))
      if (!presentHands.has('left')) pinchStateRef.current.left = false
      if (!presentHands.has('right')) pinchStateRef.current.right = false
      onHands(hands)

      const browDownLeft = getBlendshapeScore(faceResult, 'browDownLeft')
      const browDownRight = getBlendshapeScore(faceResult, 'browDownRight')
      const smileLeft = getBlendshapeScore(faceResult, 'mouthSmileLeft')
      const smileRight = getBlendshapeScore(faceResult, 'mouthSmileRight')
      const mouthOpen = getBlendshapeScore(faceResult, 'jawOpen')

      const faceData: FaceData = {
        browFurrow: clamp01((browDownLeft + browDownRight) / 2),
        smile: clamp01((smileLeft + smileRight) / 2),
        mouthOpen,
      }
      onFace(faceData)

      // 移除了每帧 console.log（gemini 调研指出 stringify 大对象是次要 GC 抖动源）；
      // 调试时改用 React DevTools / DebugPanel 实时观察。

      if (context) {
        const width = video.videoWidth
        const height = video.videoHeight
        if (width > 0 && height > 0) {
          if (canvas.width !== width) canvas.width = width
          if (canvas.height !== height) canvas.height = height
          context.clearRect(0, 0, width, height)
        }
      }
    }

    const scheduleNext = () => {
      if (cancelled) return

      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallbackId = video.requestVideoFrameCallback((_now, metadata) => {
          // metadata.mediaTime 是当前 video 帧的真实时间（秒），转 ms 给 MediaPipe
          const videoTimestampMs = (metadata?.mediaTime ?? 0) * 1000
          runInference(videoTimestampMs)
          scheduleNext()
        })
      } else {
        rafId = window.requestAnimationFrame(() => {
          runInference()
          scheduleNext()
        })
      }
    }

    const start = async () => {
      try {
        video.srcObject = stream
        video.muted = true
        video.playsInline = true

        // video.play() 返回的 Promise 可能被 cleanup 的 video.pause() 中断，
        // 抛 AbortError。这是预期清理路径，吞掉它，让真错误冒泡。
        try {
          await video.play()
        } catch (playErr: unknown) {
          if (playErr instanceof DOMException && playErr.name === 'AbortError') {
            return
          }
          throw playErr
        }

        const landmarks = await loadMediaPipeLandmarkers()
        if (cancelled) return

        faceLandmarker = landmarks.faceLandmarker
        handLandmarker = landmarks.handLandmarker
        scheduleNext()
      } catch (error) {
        console.error('[ar-hud-demo] 初始化 MediaPipe 失败', error)
      }
    }

    void start()

    return () => {
      cancelled = true

      if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallbackId)
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
      }

      video.pause()
      video.srcObject = null
    }
  }, [onFace, onGaze, onHands, stream])

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="absolute inset-0 h-full w-full scale-x-[-1] object-cover opacity-50"
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    </div>
  )
}
