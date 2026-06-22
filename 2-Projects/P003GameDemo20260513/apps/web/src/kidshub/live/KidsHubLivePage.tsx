import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useVolcRtc, type ConnectPhase } from '../../mobile/useVolcRtc';
import { MobileAvatar } from '../../mobile/MobileAvatar';
import { useAppStore } from '../../store/app-store';
import type { VoiceStatus } from '../../store/app-store';

/**
 * KidsHub-AI 体验台 · 火山 RTC 全双工实时对话（桌面 web）。
 *
 * 与现有工作台（StudioPage，WS pipeline + PTT「按住说话」）物理隔离、并存——
 * 走 /kidshub-ai/live 独立路由，不碰工作台任何功能（内测中）。
 * 复用手机端 useVolcRtc（火山 Web SDK）+ MobileAvatar（小可舞台），server 端零改动：
 * 火山云负责 ASR + 小可大脑(custom-llm /v1，固定大脑) + TTS + 3A + 语义判停 + barge-in。
 *
 * 取舍（沿用手机端已上线方案）：表情按 listening/thinking/speaking 切大类（非逐句）；
 * 字幕用火山下发整句（非 AudioContext 时钟对齐）；不支持工作台动态调 prompt（固定小可大脑）。
 */

const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: '点下方圆圈，开始和小可聊天',
  listening: '小可在认真听你说…',
  thinking: '小可正在想…',
  speaking: '小可正在说…',
};

// 首次连接进度（火山 SDK 12MB 动态加载慢）：阶段 → 文案 + 进度条百分比。
const PHASE_TEXT: Record<ConnectPhase, string> = {
  idle: '正在叫醒小可…',
  starting: '正在叫醒小可…',
  loading: '正在加载语音引擎…',
  joining: '正在接入对话…',
};
const PHASE_PCT: Record<ConnectPhase, number> = { idle: 8, starting: 22, loading: 68, joining: 92 };

/** 麦克风图标（纯 SVG primitive，taste 禁 emoji） */
function MicIcon() {
  return (
    <svg width="38" height="38" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M12 18v3M9 21h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 挂断图标 */
function StopIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}

/** 录音脉冲环 —— perpetual 动画，memo + 隔离，仅 transform/opacity（硬件加速） */
const PulseRings = React.memo(function PulseRings({ color }: { color: string }) {
  return (
    <>
      {[0, 0.55].map((delay, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="absolute h-[96px] w-[96px] rounded-full"
          style={{ background: color, willChange: 'transform, opacity' }}
          initial={{ scale: 1, opacity: 0.45 }}
          animate={{ scale: 1.75, opacity: 0 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut', delay }}
        />
      ))}
    </>
  );
});

/** 圆钮按状态取色（未连=蓝 / 听=绿 / 想说=蓝） */
function circleColor(connected: boolean, status: VoiceStatus): string {
  if (!connected) return '#0ea5e9';
  if (status === 'listening') return '#10b981';
  return '#0ea5e9';
}

export function KidsHubLivePage() {
  const { connected, connecting, connectPhase, feedbackArmed, error, needTapToPlay, start, stop, resumePlay, armFeedback } =
    useVolcRtc();
  const voiceStatus = useAppStore((s) => s.voiceStatus);
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);
  const color = circleColor(connected, voiceStatus);

  // MobileAvatar 的小可高度用 var(--app-vh)（手机端 WebView 视口单位失效的兜底）；
  // 桌面注入 innerHeight 让其按真实屏高算（仍被组件内 clamp 上限钳住），并随窗口缩放跟随。
  useEffect(() => {
    const setAppVh = () => {
      document.documentElement.style.setProperty('--app-vh', `${window.innerHeight}px`);
    };
    setAppVh();
    window.addEventListener('resize', setAppVh);
    return () => window.removeEventListener('resize', setAppVh);
  }, []);

  // 首次连接倒计时（预估，连上即止；到 1 秒停住不归零，避免"0 秒还没好"的尴尬）
  const [countdown, setCountdown] = useState(0);
  useEffect(() => {
    if (!connecting) {
      setCountdown(0);
      return;
    }
    setCountdown(20);
    const t = setInterval(() => setCountdown((n) => (n > 1 ? n - 1 : 1)), 1000);
    return () => clearInterval(t);
  }, [connecting]);

  const onCircleClick = (): void => {
    if (connecting) return;
    if (connected) void stop();
    else void start();
  };

  const statusText = connecting ? '正在叫醒小可…' : connected ? STATUS_TEXT[voiceStatus] : STATUS_TEXT.idle;

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 38%, #eff6ff 100%)' }}
    >
      {/* 顶栏：毛玻璃 pill + 体验台标识 */}
      <header className="z-10 flex items-center justify-between px-8 pt-5 pb-2">
        <div className="flex items-center gap-2.5 rounded-full border border-white/50 bg-white/55 px-4 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] backdrop-blur-md">
          <span className="text-[16px] font-semibold tracking-tight text-slate-800">小可</span>
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
            title={connected ? '对话中' : '未连接'}
          />
        </div>
        <div className="text-[12px] font-medium uppercase tracking-[0.22em] text-sky-400/70">实时语音体验</div>
      </header>

      {/* 主舞台：居中收窄，桌面留白 */}
      <main className="relative flex flex-1 flex-col items-center">
        <div className="flex w-full max-w-2xl flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <MobileAvatar />
          </div>
          {/* 桌面电影字幕：上小灰字=用户说的（ASR 转写）；下大字=小可说的 */}
          <div className="flex min-h-[6.5rem] flex-col items-center justify-center gap-1.5 px-6 pb-1">
            <p
              className="max-w-[40ch] text-center text-[1rem] font-normal leading-snug tracking-tight text-slate-400 transition-opacity duration-200"
              style={{ opacity: userSubtitle ? 1 : 0 }}
            >
              {userSubtitle ? `你：${userSubtitle}` : ' '}
            </p>
            <p
              className="max-w-[38ch] text-center text-[1.7rem] font-medium leading-snug tracking-tight text-slate-700 transition-opacity duration-200"
              style={{ opacity: subtitle ? 1 : 0 }}
            >
              {subtitle || ' '}
            </p>
          </div>
        </div>
      </main>

      {/* 底部控制区 */}
      <footer className="z-10 flex flex-col items-center gap-3.5 px-6 pb-8 pt-2">
        {connecting ? (
          <div className="flex w-full max-w-[300px] flex-col items-center gap-2">
            <p className="text-[14px] font-medium tracking-tight text-slate-500">{PHASE_TEXT[connectPhase]}</p>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80">
              <motion.div
                className="h-full rounded-full bg-sky-400"
                initial={false}
                animate={{ width: `${PHASE_PCT[connectPhase]}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            </div>
            <p className="text-[12px] tracking-tight text-slate-400">首次加载稍慢，约 {countdown} 秒…</p>
          </div>
        ) : (
          <p className="text-[14px] font-medium tracking-tight text-slate-400">{statusText}</p>
        )}
        {error && <p className="rounded-full bg-rose-50 px-3.5 py-1 text-[13px] text-rose-500">{error}</p>}
        <div className="relative flex h-[132px] w-[132px] items-center justify-center">
          {connected && <PulseRings color={`${color}40`} />}
          <motion.button
            type="button"
            aria-label={connected ? '点一下结束对话' : '点一下开始和小可对话'}
            onClick={onCircleClick}
            whileTap={{ scale: 0.94 }}
            disabled={connecting}
            className="relative flex h-[96px] w-[96px] items-center justify-center rounded-full text-white outline-none disabled:opacity-70"
            style={{
              touchAction: 'manipulation',
              WebkitUserSelect: 'none',
              background: connecting ? '#94a3b8' : color,
              boxShadow: `0 14px 36px -8px ${color}88`,
            }}
          >
            {connected ? <StopIcon /> : <MicIcon />}
          </motion.button>
        </div>
        {connected && (
          <div className="flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={() => void armFeedback()}
              className={
                feedbackArmed
                  ? 'rounded-full bg-rose-500 px-5 py-2 text-[14px] font-medium text-white shadow-[0_8px_20px_-8px_rgba(244,63,94,0.5)]'
                  : 'rounded-full border border-rose-200 bg-rose-50 px-5 py-2 text-[14px] font-medium text-rose-500 transition active:scale-[0.97] hover:bg-rose-100'
              }
            >
              {feedbackArmed ? '小可在认真听你的吐槽…' : '我要吐槽'}
            </button>
            <p className="text-[13px] tracking-tight text-slate-400">点圆圈结束对话</p>
          </div>
        )}
      </footer>

      {/* autoplay 被浏览器拦时的兜底：点一下屏幕（手势）恢复 AI 音频播放 */}
      {needTapToPlay && (
        <button
          type="button"
          onClick={resumePlay}
          className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-slate-900/55 text-white backdrop-blur-sm"
        >
          <span className="text-lg font-medium tracking-tight">点一下屏幕，让小可出声</span>
        </button>
      )}
    </div>
  );
}
