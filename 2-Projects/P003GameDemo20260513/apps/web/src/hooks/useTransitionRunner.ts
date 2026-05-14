import { useCallback } from 'react';
import { useAppStore } from '../store/app-store';
import type { BootEvent, FocusEvent, RewardEvent, Effect } from '../machines/types';
import { bootTransition, focusTransition, rewardTransition, applyEffects } from '../machines';

/**
 * useTransitionRunner —— 三机器统一事件 dispatcher + effect runner
 *
 * D3 上午接入剧情场景时，每个场景按机器类型调用 dispatchBoot/dispatchFocus/dispatchReward。
 * effect runner 在 module-scope timer 表里管理所有 setTimeout，避免泄漏。
 */
export function useTransitionRunner() {
  const dispatchBoot = useCallback((event: BootEvent) => {
    const current = useAppStore.getState().bootState;
    const { state, effects } = bootTransition(current, event);
    if (state !== current) useAppStore.getState().setBootState(state);
    runEffects(effects);
  }, []);

  const dispatchFocus = useCallback((event: FocusEvent) => {
    const current = useAppStore.getState().focusMachine;
    const { state, effects } = focusTransition(current, event);
    if (state !== current) useAppStore.getState().setFocusMachine(state);
    runEffects(effects);
  }, []);

  const dispatchReward = useCallback((event: RewardEvent) => {
    const current = useAppStore.getState().rewardMachine;
    const { state, effects } = rewardTransition(current, event);
    if (state !== current) useAppStore.getState().setRewardMachine(state);
    runEffects(effects);
  }, []);

  return { dispatchBoot, dispatchFocus, dispatchReward };
}

function runEffects(effects: readonly Effect[]): void {
  applyEffects(effects, () => {
    // timer fired —— 由调用方按 key 自己再 dispatch 对应事件（参见 boot-machine 里 ASK_MODE_TIMEOUT）
    // 这里只是 callback 注入点，具体路由放到场景组件里
  });
}
