import { useEffect, useRef } from 'react';
import { useTransitionRunner } from './useTransitionRunner';
import { useAppStore } from '../store/app-store';

// D5 P8：focus 进度按 focusStageDurationMs 驱动
// 4 阶段（locked/active/openable/full）共 4 × N 秒满；tick 200ms 让进度条平滑
const TICK_INTERVAL_MS = 200;
const STAGE_COUNT = 4;

export function useFocusProgressTick() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const focusStartedAt = useAppStore((s) => s.focusStartedAt);
  const focusProgress = useAppStore((s) => s.focusProgress);
  const focusStageDurationMs = useAppStore((s) => s.focusStageDurationMs);
  const setFocusProgress = useAppStore((s) => s.setFocusProgress);
  const { dispatchFocus } = useTransitionRunner();
  const rewardReadySentRef = useRef(false);
  const rewardLeftIdleRef = useRef(false);
  const rewardDoneSentRef = useRef(false);

  // D5 P24：进度满后不自动 dispatch FOCUS_REWARD_READY
  // 改为用户点击「收获奖励」按钮（RewardClaimButton）触发
  // 保留 rewardReadySentRef 仅为兼容，不再用作 dispatch 闸门
  void rewardReadySentRef;

  useEffect(() => {
    if (focusMachine !== 'running' || focusStartedAt === null) return;
    if (focusProgress >= 100) return;

    const cycleMs = focusStageDurationMs * STAGE_COUNT;
    let timer: number | null = null;
    const tick = () => {
      const elapsed = Date.now() - focusStartedAt;
      const nextProgress = Math.min(100, (elapsed / cycleMs) * 100);
      setFocusProgress(nextProgress);
      if (nextProgress >= 100 && timer !== null) {
        window.clearInterval(timer);
      }
    };

    tick();
    timer = window.setInterval(tick, TICK_INTERVAL_MS);
    return () => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, [focusMachine, focusProgress, focusStartedAt, focusStageDurationMs, setFocusProgress]);

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
