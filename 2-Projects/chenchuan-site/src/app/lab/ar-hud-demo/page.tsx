'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import type { FaceData, GazeData, HandData } from '@/components/lab/ar-hud-demo/MediaPipeStage'
import { BackgroundVideo } from '@/components/lab/ar-hud-demo/BackgroundVideo'
import { DebugPanel } from '@/components/lab/ar-hud-demo/DebugPanel'
import { GhostHandDemo } from '@/components/lab/ar-hud-demo/GhostHandDemo'
import { ResetCountdown } from '@/components/lab/ar-hud-demo/ResetCountdown'
import { HudOverlay, type HudData } from '@/components/lab/ar-hud-demo/HudOverlay'
import { InteractionCursor } from '@/components/lab/ar-hud-demo/interaction/InteractionCursor'
import { useInteractionState } from '@/lib/ar-hud/use-interaction-state'
import { useDragController, type PhudCardId } from '@/lib/ar-hud/use-drag-controller'
import { interactionStore } from '@/lib/ar-hud/interaction-store'

const PermissionGate = dynamic(
  () => import('@/components/lab/ar-hud-demo/PermissionGate').then((mod) => mod.PermissionGate),
  { ssr: false },
)

const INITIAL_FACE: FaceData = {
  browFurrow: 0,
  smile: 0,
  mouthOpen: 0,
}

const hudData: HudData = {
  phud: {
    speed: { value: 68, unit: 'km/h', gear: 'D', status: 'READY' },
    energy: { percent: 78, range: 312, tempC: 22, time: '7:45 PM' },
    nav: { distance: '1.2 km', instruction: 'Turn right', road: 'Seaside Blvd' },
    eta: { distance: '6.3 km', arrival: '7:57 PM' },
    media: { title: 'Endless Horizon', artist: 'Aurora Skies', progress: '1:04', duration: '3:42' },
    preview: { current: '07:15', total: '19:42', tempC: 32 },
  },
  poi: [
    {
      // Xiaomi HQ 远景：定位中远景，比 Ocean (y=56) 高 1 个卡片身位约 8%
      id: 'xiaomi',
      icon: 'Building2',
      label: 'Xiaomi Headquarters',
      distance: '6.3 km',
      x: 50,
      y: 48,
      size: 'sm',
      minutesAway: '12 min',
      arrival: '7:57 PM',
      nextManeuver: 'Turn right',
      roadName: 'Seaside Blvd',
      nextDistance: '1.2 km',
    },
    {
      // Ocean Blvd 近景：定位近处道路右侧建筑物区域（近景 0.2km 语义匹配）
      id: 'ocean',
      icon: 'Waves',
      label: 'Ocean Blvd',
      distance: '0.2 km',
      x: 78,
      y: 56,
      size: 'md',
      minutesAway: '1 min',
      arrival: '7:46 PM',
      nextManeuver: 'Slight left',
      roadName: 'Ocean Front',
      nextDistance: '200 m',
    },
  ],
}

const INITIAL_ORDER: PhudCardId[] = ['speed', 'energy', 'nav', 'eta', 'media', 'preview']

export default function ArHudDemoPage() {
  const [gaze, setGaze] = useState<GazeData>(null)
  const [hands, setHands] = useState<HandData[]>([])
  const [face, setFace] = useState<FaceData>(INITIAL_FACE)
  const [phudOrder, setPhudOrder] = useState<PhudCardId[]>(INITIAL_ORDER)
  // POI 接管：单 POI 模式（同时只激活一个），覆盖前一个
  const [activePoiId, setActivePoiId] = useState<string | null>(null)
  // Ghost Hand 引导：首次播完一轮（8s）才允许 unmount，避免用户一抬手就消失
  // 让 3 阶段教学（晃头/抬手/捏合）至少完整看完一遍
  const [ghostMinPlayed, setGhostMinPlayed] = useState(false)
  // 视频播放进度：喂给 ResetCountdown 倒计时进度条。
  // video timeupdate 标准频率 4-6 Hz（不是 60fps），setState 开销可控；
  // 下游 ResetCountdown 仅在剩余 <6s 才返回 JSX，其余时间 null，零渲染成本。
  // 其他子组件（PhudStrip / HudOverlay 等）都 memo 了，props 不变 shallow 跳过。
  const [videoProgress, setVideoProgress] = useState<{ currentTime: number; duration: number }>({
    currentTime: 0,
    duration: 0,
  })

  useEffect(() => {
    const timer = setTimeout(() => setGhostMinPlayed(true), 8000)
    return () => clearTimeout(timer)
  }, [])

  // 把 MediaPipe 数据写入 InteractionStore（不再返回 React state，避免每帧 page re-render）
  useInteractionState({ hands, gaze, face })

  // PHUD 卡 move 语义（iOS Home Screen 同款 splice insert）：
  // 不是两两 swap，而是 from 卡从原位置抽出 + 插入到 to 卡位置 → 中间所有卡整体平移。
  // 例：[A,B,C,D,E,F], A→D：移除 A → [B,C,D,E,F] → 插入 idx 3 → [B,C,D,A,E,F]
  // 川哥反馈"卡片移动换位过程不应是和目标互换，应卡片整体平移"。
  const handlePhudMove = useCallback((from: PhudCardId, to: PhudCardId) => {
    setPhudOrder((prev) => {
      const fromIdx = prev.indexOf(from)
      const toIdx = prev.indexOf(to)
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [])

  const handlePoiInject = useCallback((poiId: string) => {
    setActivePoiId(poiId)
  }, [])

  const handlePoiClear = useCallback(() => {
    setActivePoiId(null)
  }, [])

  // 视频循环 wrap → reset 所有 POI/PHUD 状态到初始
  // 川哥需求：随视频循环播完，POI 卡片自动恢复到原位置。
  // ★ 例外：如果当前有用户正在捏住的 dragging 卡，**不要 reset 那张卡**
  //   保持 dragging 卡在当前 currentOrder 位置不动，其他卡按 INITIAL_ORDER
  //   顺序填回 dragging 卡周围的位置（"被捏住的卡片原位置空出来"语义）。
  //   否则 reset 会把 dragging 卡的 layout 拽走，dragRef.startPoint 与新位置
  //   错位 → cursor 留在旧位置但卡片飞走（川哥实测截图 2 的现象）。
  const handleVideoLoop = useCallback(() => {
    const drag = interactionStore.read().drag
    const draggingCardId = drag?.kind === 'phud' ? drag.cardId : null

    setActivePoiId(null)

    if (!draggingCardId) {
      setPhudOrder(INITIAL_ORDER)
      return
    }

    setPhudOrder((prev) => {
      const draggingIdx = prev.indexOf(draggingCardId)
      if (draggingIdx < 0) return INITIAL_ORDER
      // INITIAL_ORDER 去掉 dragging 卡 → 5 张其他卡按 INITIAL 顺序
      const others = INITIAL_ORDER.filter((id) => id !== draggingCardId)
      // 在 dragging 卡的 currentOrder 位置塞回 dragging 卡，其他位置按 others 顺序填
      const result: PhudCardId[] = []
      let othersIdx = 0
      for (let i = 0; i < INITIAL_ORDER.length; i++) {
        if (i === draggingIdx) {
          result.push(draggingCardId)
        } else {
          result.push(others[othersIdx])
          othersIdx += 1
        }
      }
      return result
    })
  }, [])

  // useDragController 自订阅 store，drag 状态 React state 只在 edge 变化时 setState
  useDragController({
    onPhudMove: handlePhudMove,
    onPoiInject: handlePoiInject,
    onPoiClear: handlePoiClear,
  })

  const activePoi = activePoiId
    ? hudData.poi.find((p) => p.id === activePoiId) ?? null
    : null

  return (
    <div className="relative min-h-screen bg-black">
      {/* 左上角返回主页按钮：z-50 优先级最高，避免任何浮层挡住退出入口 */}
      <Link
        href="/"
        prefetch={false}
        className="pointer-events-auto absolute left-3 top-3 z-50 flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/55 px-3 py-1.5 text-[12px] text-white/85 backdrop-blur-md transition hover:border-[#7FE5FF]/60 hover:bg-black/75 hover:text-[#7FE5FF]"
      >
        <span aria-hidden>←</span>
        <span>返回主页</span>
      </Link>

      {/*
       * 顶部 banner：去掉算法名称（之前是"powered by MediaPipe"），改为操作指引。
       * 川哥要求："这个 demo 不显示任何和算法名称相关的信息"。
       * px-24 让出左上返回按钮 + 右侧对称留白，避免重叠。
       */}
      <div className="pointer-events-none absolute top-3 z-30 w-full px-24 text-center text-[11px] tracking-wide text-white/70 sm:text-xs">
        <span className="text-[#7FE5FF]/85">100% 本地推理 · 零数据上传</span>
        <span className="mx-2 text-white/30">·</span>
        <span className="text-white/80">捏住任意卡片可拖动 / 底部卡片可左右互换</span>
        <span className="mx-2 text-white/30">·</span>
        <span className="text-white/80">POI 卡可拖到底部接管 NAV · ETA</span>
      </div>

      <div className="relative h-screen overflow-hidden">
        <BackgroundVideo onLoop={handleVideoLoop} onTimeUpdate={setVideoProgress} />
        <HudOverlay
          data={hudData}
          order={phudOrder}
          activePoi={activePoi}
          activePoiId={activePoiId}
        />
        <ResetCountdown currentTime={videoProgress.currentTime} duration={videoProgress.duration} />
        <InteractionCursor />
        {/* G2 Ghost Hand 引导：首次至少播完一轮 8s 教学循环后才允许 unmount，
            避免用户一抬手就消失看不完。已播完 + 抬手 → unmount；
            未播完 → 强制显示直到 8s 满。解决"不知道怎么玩"流失。 */}
        {(!ghostMinPlayed || hands.length === 0) && <GhostHandDemo />}
        <DebugPanel />

        {/*
         * cam feed 包装：未抬手时（hands 空）加 ar-hud-cam-pulse 脉冲发光边框，
         * 配合 GhostHandDemo 顶部的"先开启右下角摄像头 ↘"指向，强吸引视线。
         * 一旦用户抬手识别成功，hands.length>0 → 移除脉冲让视觉回归静态。
         */}
        <div
          className={`pointer-events-auto absolute bottom-6 right-6 z-40 w-[min(30vw,248px)] min-w-[168px] overflow-hidden rounded-[10px] border border-[#7fe5ff]/50 bg-black/65 shadow-[0_0_28px_rgba(127,229,255,0.2)] backdrop-blur-sm ${hands.length === 0 ? 'ar-hud-cam-pulse' : ''}`}
        >
          <div
            className="border-b border-[#7fe5ff]/35 px-2 py-1 text-[10px] uppercase tracking-[0.22em] text-[#7fe5ff]/90"
            style={{ fontFamily: 'JetBrains Mono, Geist Mono, ui-monospace, SFMono-Regular, monospace' }}
          >
            Cam Feed
          </div>
          <div className="aspect-video bg-black">
            <PermissionGate onGaze={setGaze} onHands={setHands} onFace={setFace} />
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes arHudCamPulse {
          0%,
          100% {
            box-shadow: 0 0 28px rgba(127, 229, 255, 0.25);
            border-color: rgba(127, 229, 255, 0.5);
          }
          50% {
            box-shadow: 0 0 60px rgba(127, 229, 255, 0.85);
            border-color: rgba(127, 229, 255, 1);
          }
        }
        .ar-hud-cam-pulse {
          animation: arHudCamPulse 1.8s ease-in-out infinite;
        }
      `}</style>
    </div>
  )
}
