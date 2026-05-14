import { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import type { BootEvent, FocusEvent, RewardEvent } from '../machines/types';
import {
  bootTransition,
  focusTransition,
  rewardTransition,
  applyEffects,
  defaultTimerRouter,
} from '../machines';

/**
 * useTransitionRunner —— 三机器统一事件 dispatcher
 *
 * applyEffects 内部 timer fire 时调用 defaultTimerRouter（在 machines/index.ts）
 * 自动 fire 下一个事件，组件不必关心 timer key。
 */
export function useTransitionRunner() {
  const dispatchBoot = useCallback((event: BootEvent) => {
    const current = useAppStore.getState().bootState;
    const { state, effects } = bootTransition(current, event);
    if (state !== current) useAppStore.getState().setBootState(state);
    applyEffects(effects, defaultTimerRouter);
  }, []);

  const dispatchFocus = useCallback((event: FocusEvent) => {
    const current = useAppStore.getState().focusMachine;
    const { state, effects } = focusTransition(current, event);
    if (state !== current) useAppStore.getState().setFocusMachine(state);
    // focusMode 副作用：LAUNCH 设置 mode（用户从 askMode 选完进入 launching），
    // 退回 idle 清空。让 focus 场景视图能根据 focusMode 区分出航/静思 UI 差异，
    // 不依赖 jumpToScene 一次性 hydrate。
    if (event.type === 'LAUNCH') {
      useAppStore.getState().setFocusMode(event.mode);
    } else if (state === 'idle' && current !== 'idle') {
      useAppStore.getState().setFocusMode(null);
    }
    applyEffects(effects, defaultTimerRouter);
  }, []);

  const dispatchReward = useCallback((event: RewardEvent) => {
    const current = useAppStore.getState().rewardMachine;
    const { state, effects } = rewardTransition(current, event);
    if (state !== current) useAppStore.getState().setRewardMachine(state);
    applyEffects(effects, defaultTimerRouter);
  }, []);

  return { dispatchBoot, dispatchFocus, dispatchReward };
}
