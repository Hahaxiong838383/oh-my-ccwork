import { useEffect, useRef } from 'react';
import { useTransitionRunner } from './useTransitionRunner';
import { useAppStore } from '../store/app-store';

const BASE_RATE = 1.0;

export function useFocusProgressTick() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const focusStartedAt = useAppStore((s) => s.focusStartedAt);
  const focusProgress = useAppStore((s) => s.focusProgress);
  const focusSpeed = useAppStore((s) => s.focusSpeed);
  const setFocusProgress = useAppStore((s) => s.setFocusProgress);
  const { dispatchFocus } = useTransitionRunner();
  const rewardReadySentRef = useRef(false);
  const rewardLeftIdleRef = useRef(false);
  const rewardDoneSentRef = useRef(false);

  useEffect(() => {
    if (focusMachine === 'running') return;
    rewardReadySentRef.current = false;
  }, [focusMachine]);

  useEffect(() => {
    if (focusMachine !== 'running') return;
    if (focusProgress < 100) return;
    if (rewardReadySentRef.current) return;
    rewardReadySentRef.current = true;
    dispatchFocus({ type: 'FOCUS_REWARD_READY' });
  }, [dispatchFocus, focusMachine, focusProgress]);

  useEffect(() => {
    if (focusMachine !== 'running' || focusStartedAt === null) return;
    if (focusProgress >= 100) return;

    let timer: number | null = null;
    const tick = () => {
      const nextProgress = Math.min(
        100,
        ((Date.now() - focusStartedAt) / 1000) * focusSpeed * BASE_RATE,
      );
      setFocusProgress(nextProgress);
      if (nextProgress >= 100 && timer !== null) {
        window.clearInterval(timer);
      }
    };

    tick();
    timer = window.setInterval(tick, 1_000);
    return () => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, [focusMachine, focusProgress, focusStartedAt, focusSpeed, setFocusProgress]);

  useEffect(() => {
    if (focusMachine !== 'rewarding') {
      rewardLeftIdleRef.current = false;
      rewardDoneSentRef.current = false;
      return;
    }

    if (!rewardLeftIdleRef.current && rewardMachine !== 'idle') {
      rewardLeftIdleRef.current = true;
      return;
    }

    if (!rewardLeftIdleRef.current) return;
    if (rewardMachine !== 'idle' && rewardMachine !== 'done') return;
    if (rewardDoneSentRef.current) return;

    rewardDoneSentRef.current = true;
    dispatchFocus({ type: 'REWARD_FLOW_DONE' });
  }, [dispatchFocus, focusMachine, rewardMachine]);
}
