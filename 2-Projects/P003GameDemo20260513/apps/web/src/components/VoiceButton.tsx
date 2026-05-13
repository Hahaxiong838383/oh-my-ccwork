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
      className={`relative h-16 w-16 rounded-full text-2xl text-white shadow-lg transition-all duration-150 active:scale-105 ${
        pressed
          ? 'scale-110 bg-red-500 ring-4 ring-red-300/50 animate-pulse'
          : 'bg-gradient-to-br from-xiaoke-primary to-xiaoke-accent ring-2 ring-white/20'
      }`}
    >
      <span className="relative z-10">🎤</span>
      {pressed && <span className="absolute inset-0 rounded-full border border-red-200/60 animate-ping" />}
    </button>
  );
}
