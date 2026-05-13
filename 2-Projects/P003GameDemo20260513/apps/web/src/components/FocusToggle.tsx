import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { useFeedbackQueue } from '../store/feedback-queue';

interface FocusToggleProps {}

export function FocusToggle(_props: FocusToggleProps) {
  const focusStatus = useAppStore((s) => s.focusStatus);
  const setFocusStatus = useAppStore((s) => s.setFocusStatus);
  const addFamilyCoin = useAppStore((s) => s.addFamilyCoin);

  const [countdown, setCountdown] = useState<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const finishTimerRef = useRef<number | null>(null);

  const clearCountdown = () => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  };

  const finishFocus = () => {
    clearCountdown();
    setCountdown(null);
    addFamilyCoin(10);
    setFocusStatus('idle');
    useFeedbackQueue.getState().pushTip('获得家族币 +10');
  };

  const startReturnCountdown = () => {
    if (countdown !== null) return;

    setCountdown(4);
    intervalRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) return prev;
        return prev - 1;
      });
    }, 1000);
    finishTimerRef.current = window.setTimeout(() => {
      finishFocus();
    }, 5000);
  };

  const onClick = () => {
    if (focusStatus === 'idle') {
      setFocusStatus('running');
      setCountdown(null);
      return;
    }
    startReturnCountdown();
  };

  useEffect(() => {
    return () => clearCountdown();
  }, []);

  const running = focusStatus === 'running';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-10 min-w-[120px] rounded-2xl px-4 text-sm font-semibold transition active:scale-[0.98] ${
        running
          ? 'border border-white/50 bg-white/10 text-white shadow-[0_0_18px_rgba(255,255,255,0.15)]'
          : 'bg-porthole-glow/80 text-white shadow-[0_0_22px_rgba(79,209,255,0.45)] hover:bg-porthole-glow'
      }`}
    >
      {!running && '启航'}
      {running && countdown === null && '返舱'}
      {running && countdown !== null && `专注中 ${countdown}..`}
    </button>
  );
}
