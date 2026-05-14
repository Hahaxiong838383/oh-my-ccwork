import { useCallback, useEffect, useRef, useState } from 'react';

interface CountdownOptions {
  seconds: number;
  onTimeout?: () => void;
  active?: boolean;
}

/**
 * useCountdown —— 倒计时 hook（iOS 后台节流安全）
 *
 * codex 风险登记：iOS Safari 切出再回来 setInterval 漂移。
 * 实现：用 deadlineMs (Date.now() + seconds*1000) 替代 setInterval 自减；
 * tick 用 100ms setInterval 重算剩余；visibilitychange 时强制重算一次。
 */
export function useCountdown({ seconds, onTimeout, active = true }: CountdownOptions) {
  const [remainingMs, setRemainingMs] = useState(seconds * 1_000);
  const deadlineRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const reset = useCallback(() => {
    deadlineRef.current = Date.now() + seconds * 1_000;
    firedRef.current = false;
    setRemainingMs(seconds * 1_000);
  }, [seconds]);

  useEffect(() => {
    if (!active) {
      deadlineRef.current = null;
      return;
    }
    if (deadlineRef.current === null) {
      deadlineRef.current = Date.now() + seconds * 1_000;
      firedRef.current = false;
      setRemainingMs(seconds * 1_000);
    }

    const tick = () => {
      if (deadlineRef.current === null) return;
      const remaining = Math.max(0, deadlineRef.current - Date.now());
      setRemainingMs(remaining);
      if (remaining <= 0 && !firedRef.current) {
        firedRef.current = true;
        onTimeoutRef.current?.();
      }
    };

    const intervalId = window.setInterval(tick, 100);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, seconds]);

  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
    progress: remainingMs / (seconds * 1_000),
    reset,
  };
}
