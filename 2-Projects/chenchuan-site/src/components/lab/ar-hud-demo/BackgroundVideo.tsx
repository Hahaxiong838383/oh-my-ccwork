'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

const VIDEO_SRC = '/media/ar-hud-demo/driver-view-loop.mp4'
// 视频 loop wrap 检测阈值：currentTime 突然减少 > 此值视为一个循环结束
const LOOP_WRAP_THRESHOLD_S = 0.5

interface BackgroundVideoProps {
  onLoop?: () => void
  onTimeUpdate?: (info: { currentTime: number; duration: number }) => void
}

export function BackgroundVideo({ onLoop, onTimeUpdate }: BackgroundVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoReady, setVideoReady] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)
  const lastTimeRef = useRef(0)
  const onLoopRef = useRef(onLoop)
  const onTimeUpdateRef = useRef(onTimeUpdate)
  onLoopRef.current = onLoop
  onTimeUpdateRef.current = onTimeUpdate

  // 视频 loop wrap 检测：currentTime 跳变到接近 0 即视为新一轮开始
  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>): void => {
    const now = e.currentTarget.currentTime
    onTimeUpdateRef.current?.({
      currentTime: now,
      duration: e.currentTarget.duration || 0,
    })
    if (now + LOOP_WRAP_THRESHOLD_S < lastTimeRef.current) {
      onLoopRef.current?.()
    }
    lastTimeRef.current = now
  }

  // HMR / 重挂载时主动触发一次 load，避免 video 卡在加载失败的 sticky 状态
  useEffect(() => {
    setVideoFailed(false)
    setVideoReady(false)
    const v = videoRef.current
    if (!v) return
    v.load()
    // 浏览器 autoplay 限制：muted 视频可以自动播放，但偶尔需要显式 play()
    void v.play().catch(() => {
      // 静默吞 AbortError / NotAllowedError，让 fallback 兜底
    })
  }, [])

  const stars = useMemo(
    () =>
      Array.from({ length: 24 }, (_, index) => ({
        id: index,
        top: `${(index * 37) % 100}%`,
        left: `${(index * 19 + 13) % 100}%`,
        delay: `${(index % 7) * 0.55}s`,
        duration: `${6 + (index % 5)}s`,
        size: 1 + (index % 3),
      })),
    [],
  )

  const showFallback = videoFailed || !videoReady

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      <div
        className={`absolute inset-0 transition-opacity duration-700 ${showFallback ? 'opacity-100' : 'opacity-35'}`}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(127,229,255,0.12),transparent_44%),radial-gradient(circle_at_82%_78%,rgba(164,232,49,0.12),transparent_48%),linear-gradient(170deg,#020304_0%,#05060A_45%,#000000_100%)]" />

        <div className="absolute inset-0">
          {stars.map((star) => (
            <span
              key={star.id}
              className="hud-fallback-star absolute rounded-full bg-[#b9f0ff]/80"
              style={{
                top: star.top,
                left: star.left,
                width: `${star.size}px`,
                height: `${star.size}px`,
                animationDelay: star.delay,
                animationDuration: star.duration,
              }}
            />
          ))}
        </div>

        <div className="absolute inset-0 bg-[linear-gradient(transparent_65%,rgba(0,0,0,0.45)_100%)]" />
      </div>

      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        onCanPlay={(e) => {
          setVideoReady(true)
          void e.currentTarget.play().catch(() => {})
        }}
        onLoadedData={(e) => {
          setVideoReady(true)
          void e.currentTarget.play().catch(() => {})
        }}
        onTimeUpdate={handleTimeUpdate}
        onError={() => setVideoFailed(true)}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${videoFailed ? 'opacity-0' : videoReady ? 'opacity-100' : 'opacity-60'} hue-rotate-[2deg] saturate-[1.08] brightness-[0.72] contrast-[1.08]`}
        src={VIDEO_SRC}
      />


      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.28)_0%,rgba(0,0,0,0.52)_100%)]" />

      <style jsx>{`
        .hud-fallback-star {
          animation-name: hudStarDrift;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }

        @keyframes hudStarDrift {
          0% {
            opacity: 0.12;
            transform: translate3d(0, 0, 0) scale(0.85);
          }
          50% {
            opacity: 0.9;
            transform: translate3d(0, -8px, 0) scale(1.25);
          }
          100% {
            opacity: 0.15;
            transform: translate3d(0, -16px, 0) scale(0.8);
          }
        }
      `}</style>
    </div>
  )
}
