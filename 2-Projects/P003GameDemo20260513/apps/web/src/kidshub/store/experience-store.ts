import { create } from 'zustand';

/**
 * 体验限额漏斗 store（仅个人站公开模式 VITE_KIDSHUB_PUBLIC=1 生效）
 *
 * 目标是 lead generation：HR/访客体验几次后引导加微信，不是防刷
 * （防刷由 server guard.ts per-IP 兜底，两层平行）。
 *
 * 两个独立计数器：
 *  - sceneClicks（场景卡点击 = 浏览，上限 6）：点卡触发的自动开场白不算进对话额度
 *  - voiceRounds（按住说话 = 深度语音对话，上限 5）
 *
 * 软退路：场景卡超限后首次弹窗，之后只切画面看美术（不再发对话、不再弹）；
 * 语音超限后按住说话即弹窗引导（语音是真消耗，不放行但不锁死整个界面）。
 */

// 仅个人站公开部署启用限额漏斗；公司侧（VITE_KIDSHUB_PUBLIC 未设）完全不拦
export const EXPERIENCE_QUOTA_ENABLED =
  (import.meta as { env?: Record<string, string> }).env?.VITE_KIDSHUB_PUBLIC === '1';

export const MAX_SCENE_CLICKS = 6;
export const MAX_VOICE_ROUNDS = 5;
// 峰值轻提示触发点：体验到这个次数（爽点）后顶部出现一行非阻断软引导
const SCENE_HINT_AT = 3;
const VOICE_HINT_AT = 2;

const STORAGE_KEY = 'kidshub.experience.quota.v1';

interface PersistShape {
  sceneClicks: number;
  voiceRounds: number;
  modalShownOnce: boolean;
}

function loadPersisted(): PersistShape {
  const fallback: PersistShape = { sceneClicks: 0, voiceRounds: 0, modalShownOnce: false };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    return {
      sceneClicks: Number(parsed.sceneClicks) || 0,
      voiceRounds: Number(parsed.voiceRounds) || 0,
      modalShownOnce: Boolean(parsed.modalShownOnce),
    };
  } catch {
    return fallback;
  }
}

function persist(shape: PersistShape): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // localStorage 不可用（隐私模式/配额满）：降级为内存计数，不阻断体验
  }
}

interface ExperienceState {
  sceneClicks: number;
  voiceRounds: number;
  modalShownOnce: boolean;
  modalOpen: boolean;
  hintDismissed: boolean; // session 级，不持久化

  // guard：还能不能继续（true = 未超限）
  canScene: () => boolean;
  canVoice: () => boolean;

  // 计数（仅在未超限正常消耗时调用）
  recordSceneClick: () => void;
  recordVoiceRound: () => void;

  // 峰值轻提示是否该显示（任一计数到爽点、未被关、且都未超限——超限有弹窗就不需要轻提示了）
  shouldShowHint: () => boolean;
  dismissHint: () => void;

  // 弹窗
  openModal: () => void;
  closeModal: () => void;

  reset: () => void; // 调试/测试用
}

export const useExperienceStore = create<ExperienceState>((set, get) => {
  const init = loadPersisted();
  return {
    sceneClicks: init.sceneClicks,
    voiceRounds: init.voiceRounds,
    modalShownOnce: init.modalShownOnce,
    modalOpen: false,
    hintDismissed: false,

    canScene: () => get().sceneClicks < MAX_SCENE_CLICKS,
    canVoice: () => get().voiceRounds < MAX_VOICE_ROUNDS,

    recordSceneClick: () =>
      set((s) => {
        const sceneClicks = s.sceneClicks + 1;
        persist({ sceneClicks, voiceRounds: s.voiceRounds, modalShownOnce: s.modalShownOnce });
        return { sceneClicks };
      }),

    recordVoiceRound: () =>
      set((s) => {
        const voiceRounds = s.voiceRounds + 1;
        persist({ sceneClicks: s.sceneClicks, voiceRounds, modalShownOnce: s.modalShownOnce });
        return { voiceRounds };
      }),

    shouldShowHint: () => {
      const s = get();
      if (s.hintDismissed) return false;
      const overLimit = s.sceneClicks >= MAX_SCENE_CLICKS || s.voiceRounds >= MAX_VOICE_ROUNDS;
      if (overLimit) return false;
      return s.sceneClicks >= SCENE_HINT_AT || s.voiceRounds >= VOICE_HINT_AT;
    },
    dismissHint: () => set({ hintDismissed: true }),

    openModal: () =>
      set((s) => {
        if (!s.modalShownOnce) {
          persist({ sceneClicks: s.sceneClicks, voiceRounds: s.voiceRounds, modalShownOnce: true });
        }
        return { modalOpen: true, modalShownOnce: true };
      }),
    closeModal: () => set({ modalOpen: false }),

    reset: () => {
      persist({ sceneClicks: 0, voiceRounds: 0, modalShownOnce: false });
      set({ sceneClicks: 0, voiceRounds: 0, modalShownOnce: false, modalOpen: false, hintDismissed: false });
    },
  };
});
