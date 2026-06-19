import React from 'react';
import { motion } from 'framer-motion';
import { useMobileVoice } from './useMobileVoice';
import { MobileAvatar } from './MobileAvatar';
import { MobileSubtitle } from './MobileSubtitle';
import { useAppStore } from '../store/app-store';
import type { VoiceStatus } from '../store/app-store';

const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: '按住下面的圆圈，和小可说说话',
  listening: '小可在认真听你说…',
  thinking: '小可正在想…',
  speaking: '小可正在说…',
};

/** 麦克风图标（纯 SVG primitive，taste 禁 emoji） */
function MicIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M12 18v3M9 21h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 录音脉冲环 —— perpetual 动画，memo + 隔离，仅 transform/opacity（硬件加速） */
const PulseRings = React.memo(function PulseRings() {
  return (
    <>
      {[0, 0.55].map((delay, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="absolute h-[88px] w-[88px] rounded-full bg-rose-400/25"
          style={{ willChange: 'transform, opacity' }}
          initial={{ scale: 1, opacity: 0.5 }}
          animate={{ scale: 1.75, opacity: 0 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay }}
        />
      ))}
    </>
  );
});

interface PttButtonProps {
  recording: boolean;
  status: VoiceStatus;
  onDown: () => void;
  onUp: () => void;
  onBarge: () => void;
}

function PttButton({ recording, status, onDown, onUp, onBarge }: PttButtonProps) {
  return (
    <div className="relative flex h-[124px] w-[124px] items-center justify-center">
      {recording && <PulseRings />}
      <motion.button
        type="button"
        aria-label={status === 'speaking' ? '点一下打断小可' : '按住和小可说话'}
        onPointerDown={(e) => {
          e.preventDefault();
          // 小可正在说时，点一下 = 打断（孩子想插话）；否则按住录音
          if (status === 'speaking') {
            onBarge();
            return;
          }
          onDown();
        }}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
        whileTap={{ scale: 0.94 }}
        className="relative flex h-[88px] w-[88px] items-center justify-center rounded-full text-white outline-none"
        style={{
          touchAction: 'none',
          WebkitUserSelect: 'none',
          background: recording ? '#f43f5e' : '#0ea5e9',
          // tinted diffusion shadow（taste：禁 neon glow，用染色扩散阴影）
          boxShadow: recording
            ? '0 12px 32px -8px rgba(244,63,94,0.55)'
            : '0 12px 32px -8px rgba(14,165,233,0.5)',
        }}
      >
        <MicIcon />
      </motion.button>
    </div>
  );
}

/**
 * 移动端主界面 —— 苹果简洁科技清新风（taste baseline 调向 airy/低密度）：
 * 顶栏毛玻璃 pill + 小可站立舞台 + 字幕 + 底部拇指区 PTT 大圆。
 * 唤醒词「小可小可」由原生壳提供（无壳自动隐藏唤醒提示，PTT 兜底）。
 */
export function MobileMain() {
  const { pressed, connected, wakeAvailable, listeningByWake, onPttDown, onPttUp, bargeIn } =
    useMobileVoice();
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const recording = pressed || listeningByWake;

  return (
    <div
      className="relative flex min-h-[100dvh] flex-col overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 40%, #eff6ff 100%)' }}
    >
      {/* 顶栏：毛玻璃 pill（liquid glass：内高光边 + 模糊） */}
      <header className="z-10 flex items-center justify-between px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <div className="flex items-center gap-2 rounded-full border border-white/50 bg-white/55 px-3.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] backdrop-blur-md">
          <span className="text-[15px] font-semibold tracking-tight text-slate-800">小可</span>
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              connected ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
            title={connected ? '已连接' : '连接中…'}
          />
        </div>
      </header>

      {/* 主舞台 */}
      <main className="relative flex flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <MobileAvatar />
        </div>
        <MobileSubtitle />
      </main>

      {/* 底部控制区（拇指区，安全区内边距） */}
      <footer className="z-10 flex flex-col items-center gap-3 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2">
        {wakeAvailable && voiceStatus === 'idle' && !recording && (
          <div className="rounded-full border border-sky-100 bg-sky-50/70 px-3 py-1 text-[12px] tracking-tight text-sky-600 backdrop-blur">
            试试喊「小可小可」叫醒我
          </div>
        )}
        <p className="text-[13px] font-medium tracking-tight text-slate-400">
          {STATUS_TEXT[voiceStatus] ?? STATUS_TEXT.idle}
        </p>
        <PttButton
          recording={recording}
          status={voiceStatus}
          onDown={onPttDown}
          onUp={onPttUp}
          onBarge={bargeIn}
        />
      </footer>
    </div>
  );
}
