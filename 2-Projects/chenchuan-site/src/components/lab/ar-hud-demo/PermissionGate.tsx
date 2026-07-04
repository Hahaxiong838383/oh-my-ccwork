'use client'

import dynamic from 'next/dynamic'
import { useEffect, useMemo, useState } from 'react'
import type { FaceData, GazeData, HandData } from './MediaPipeStage'
import { unlockAudio } from '@/lib/ar-hud/audio-feedback'

type PermissionStatus = 'pending' | 'granted' | 'denied'

interface PermissionGateProps {
  onGaze: (gaze: GazeData) => void
  onHands: (hands: HandData[]) => void
  onFace: (face: FaceData) => void
}

const MediaPipeStage = dynamic(
  () => import('./MediaPipeStage').then((mod) => mod.MediaPipeStage),
  {
    ssr: false,
    // 不显示"正在加载 MediaPipe"文字（破坏沉浸感），改用纯黑透明占位让背景视频
    // 透出来，加载完成 (~1s) 自动切到 MediaPipeStage
    loading: () => <div className="h-full w-full bg-black/30" />,
  },
)

export function PermissionGate({ onGaze, onHands, onFace }: PermissionGateProps) {
  const [status, setStatus] = useState<PermissionStatus>('pending')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [errorText, setErrorText] = useState<string>('')

  // 移动端检测：iOS Safari MediaPipe 跑双模型会 thermal throttling (gemini 调研)，
  // Android Chrome 普遍 GPU 加速差。统一 fallback 到"请桌面端访问"，避免劣体验。
  const isMobile = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent
    return /iPhone|iPad|iPod|Android|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(ua)
  }, [])

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [stream])

  // gemini 调研警告：iOS Safari 切标签会强制终止 camera stream，回来时永久黑屏
  // 修复：监听 visibilitychange，页面恢复可见时检测 stream 失活则重新申请
  useEffect(() => {
    if (status !== 'granted' || !stream) return

    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible') return

      const tracks = stream.getTracks()
      const allDead = tracks.length === 0 || tracks.every((t) => t.readyState === 'ended')

      if (allDead) {
        try {
          const fresh = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
            audio: false,
          })
          setStream(fresh)
        } catch (error) {
          console.error('[ar-hud-demo] visibilitychange 恢复失败', error)
          setStatus('denied')
          setErrorText('摄像头流已断开，请重新授权')
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [status, stream])

  const handleRequestPermission = async () => {
    setErrorText('')

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          // gemini 调研推荐：MediaPipe 在 640x480 下 CPU 单帧 ~10-15ms，
          // 1280x720 要 30-50ms，会卡。降采样不影响检测精度。
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      })

      setStream((prev) => {
        prev?.getTracks().forEach((track) => track.stop())
        return mediaStream
      })
      setStatus('granted')
    } catch (error) {
      console.error('[ar-hud-demo] 摄像头授权失败', error)
      setStatus('denied')
      setErrorText('需要摄像头权限')
    }
  }

  if (isMobile) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="flex max-w-[260px] flex-col items-center gap-3 rounded-md border border-[#7FE5FF]/30 bg-black/65 px-4 py-4 text-center backdrop-blur-md">
          <div className="text-[20px]">🖥️</div>
          <p className="text-[12px] leading-5 text-white/85">
            移动端暂不支持手势交互
            <br />
            请在桌面浏览器打开
          </p>
          <a
            href="/"
            className="rounded border border-white/25 px-3 py-1.5 text-[11px] text-white/85 transition hover:border-[#7FE5FF]/50 hover:text-[#7FE5FF]"
          >
            返回首页
          </a>
        </div>
      </div>
    )
  }

  if (status === 'granted' && stream) {
    return <MediaPipeStage stream={stream} onGaze={onGaze} onHands={onHands} onFace={onFace} />
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 rounded-md border border-[#7FE5FF]/35 bg-black/65 px-5 py-4 backdrop-blur-md">
        <p className="text-center text-[12px] text-white/85">
          {status === 'denied' ? errorText || '需要摄像头权限' : '点击开启摄像头'}
        </p>
        <button
          type="button"
          onClick={() => {
            unlockAudio()
            void handleRequestPermission()
          }}
          className="ar-hud-permission-btn flex items-center gap-2 rounded-full border border-[#7FE5FF]/70 bg-[#7FE5FF]/[0.14] px-5 py-2.5 text-[13px] font-semibold text-[#7FE5FF] shadow-[0_0_24px_rgba(127,229,255,0.45)] transition hover:bg-[#7FE5FF]/[0.22] hover:shadow-[0_0_42px_rgba(127,229,255,0.75)]"
        >
          <span>📷</span>
          <span>{status === 'denied' ? '重试授权' : '开启摄像头'}</span>
        </button>
      </div>
      <style jsx>{`
        @keyframes permissionBtnPulse {
          0%,
          100% {
            box-shadow: 0 0 24px rgba(127, 229, 255, 0.45);
          }
          50% {
            box-shadow: 0 0 48px rgba(127, 229, 255, 0.9);
          }
        }
        .ar-hud-permission-btn {
          animation: permissionBtnPulse 1.6s ease-in-out infinite;
        }
      `}</style>
    </div>
  )
}
