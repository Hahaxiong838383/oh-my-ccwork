import { useEffect } from 'react';
import { useAppStore } from '../store/app-store';

const BASE_RATE = 1.0;

export function useFocusProgressTick() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusStartedAt = useAppStore((s) => s.focusStartedAt);
  const focusSpeed = useAppStore((s) => s.focusSpeed);
  const setFocusProgress = useAppStore((s) => s.setFocusProgress);

  useEffect(() => {
    if (focusMachine !== 'running' || focusStartedAt === null) return;

    const tick = () => {
      const nextProgress = Math.min(
        100,
        ((Date.now() - focusStartedAt) / 1000) * focusSpeed * BASE_RATE,
      );
      setFocusProgress(nextProgress);
    };

    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [focusMachine, focusStartedAt, focusSpeed, setFocusProgress]);
}
