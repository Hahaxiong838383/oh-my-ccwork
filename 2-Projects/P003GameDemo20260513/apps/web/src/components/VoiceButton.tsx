import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';

interface VoiceButtonProps {}

export function VoiceButton(_props: VoiceButtonProps) {
  const setVoiceStatus = useAppStore((s) => s.setVoiceStatus);
  const setSubtitle = useAppStore((s) => s.setSubtitle);
  const setXiaokeEmotion = useAppStore((s) => s.setXiaokeEmotion);

  const [pressed, setPressed] = useState(false);
  const speakingTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);

  const clearFlowTimers = () => {
    if (speakingTimerRef.current !== null) {
      window.clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  const runReleaseFlow = () => {
    setPressed(false);
    clearFlowTimers();

    setVoiceStatus('thinking');
    setXiaokeEmotion('calm');

    speakingTimerRef.current = window.setTimeout(() => {
      setVoiceStatus('speaking');
      setXiaokeEmotion('happy');
      setSubtitle('你好指挥官，今天想做什么呀？');
    }, 600);

    idleTimerRef.current = window.setTimeout(() => {
      setVoiceStatus('idle');
      setXiaokeEmotion('happy');
    }, 2100);
  };

  const onPointerDown = () => {
    setPressed(true);
    clearFlowTimers();
    setVoiceStatus('listening');
    setXiaokeEmotion('curious');
  };

  const onPointerUp = () => {
    if (!pressed) return;
    runReleaseFlow();
  };

  useEffect(() => {
    return () => clearFlowTimers();
  }, []);

  return (
    <button
      type="button"
      aria-label="按住说话"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      className={`relative inline-flex h-9 select-none items-center gap-2 rounded-full px-5 text-[11px] tracking-widest transition-all duration-150 ${
        pressed
          ? 'bg-red-500/90 text-white shadow-[0_0_18px_rgba(239,68,68,0.6)] ring-2 ring-red-300/50'
          : 'bg-shell-trim text-white/70 shadow-inner shadow-black/40 ring-1 ring-white/5 hover:text-white/90'
      }`}
    >
      <span className={`text-[14px] leading-none ${pressed ? '' : 'opacity-80'}`}>🎤</span>
      <span>{pressed ? '聆听中…' : '按住说话'}</span>
      {pressed && (
        <span className="absolute inset-0 rounded-full border border-red-200/40 animate-ping" />
      )}
    </button>
  );
}
