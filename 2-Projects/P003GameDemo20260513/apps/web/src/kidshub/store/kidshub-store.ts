import { create } from 'zustand';
import {
  GLOBAL_SYSTEM_PROMPT,
  DEFAULT_ADDENDUM,
  SCENE_CARDS,
  getSceneCard,
  defaultVariableValues,
  composeSystemPrompt,
} from '../prompts';
import { sampleDeviceState } from '../prompts/sample';
import { getKnowledge } from '../knowledge/get-knowledge';
import type { LoreSection } from '../knowledge/types';

const TOKEN_KEY = 'kidshub.token';
const DRAFTS_KEY = 'kidshub.scenePromptDrafts';
// 出厂 prompt 变更时 bump key 让旧 localStorage 缓存失效
// （否则老用户的缓存会盖住新出厂值，永远拿不到新指令）
// globalTemplate.v4：【称呼】注入 {gender}（登录页收集孩子性别，让小可知道但不贴性别标签）
// globalTemplate.v3：世界观+读写台玻璃光学原理（画面在 3 米外，护眼根本逻辑）
// addendum.v5：规则 8 收紧——参照物只许"读写台玻璃"，去掉"书本"（川哥钦定 2026-06-13）
const GLOBALS_KEY = 'kidshub.globalTemplate.v4';
const VARS_KEY = 'kidshub.variables';
const ADDENDUM_KEY = 'kidshub.addendum.v5';
// 需求3：小可语速（1 / 1.5 / 2），持久化
const VOICE_SPEED_KEY = 'kidshub.voiceSpeed';

export interface DebugEntry {
  ts: number;
  kind: 'action' | 'asr' | 'llm' | 'tts' | 'prompt' | 'config' | 'perf' | 'avatar' | 'error';
  title: string;
  detail?: string;
}

interface KidsHubState {
  // auth
  token: string | null;

  // selection (卡与版块互斥)
  activeCardId: string | null;
  activeSectionId: string | null;

  // editable
  globalTemplate: string;
  scenePromptDrafts: Record<string, string>;
  variables: Record<string, string>;
  // 工程附加规则（防示例复读 + KidsHub 全局响应），清空 = 关闭
  addendum: string;

  // 需求3：小可语速（TTS 播放速率）1 / 1.5 / 2
  voiceSpeed: number;
  setVoiceSpeed: (n: number) => void;

  // debug
  debugLog: DebugEntry[];

  // dirty flag for "未下发"
  promptDirty: boolean;

  // 上次用过的 framing 表达角度 id（会话内追踪，避免连续同角度；不持久化）
  lastFramingAngle: string | null;
  setLastFramingAngle: (id: string | null) => void;

  // 各描述类字段「最近 N 次」选中的事实（会话内追踪，走遍整池才重复；不持久化）
  recentFactPicks: Record<string, string[]>;
  // 世界观 lore 节最近使用记录，按 cardId 分桶（对抗审查 No.3：避免跨卡借走素材；参考 recentFactPicks）
  recentLoreByCard: Record<string, string[]>;
  // 采样版组装：device_state 事实采样 + 世界观 lore 注入，返回 prompt + picks + 本次 loreSections（供 debug/UI 展示注入内容）
  getComposedPromptSampled: () => { prompt: string; picks: Record<string, string>; loreSections: LoreSection[] };

  // actions
  setToken: (t: string | null) => void;
  selectCard: (id: string) => void;
  selectSection: (id: string) => void;
  editGlobal: (text: string) => void;
  editScenePrompt: (cardId: string, text: string) => void;
  editAddendum: (text: string) => void;
  setVariable: (key: string, value: string) => void;
  resetCard: (cardId: string) => void;
  resetAll: () => void;
  pushDebug: (entry: Omit<DebugEntry, 'ts'>) => void;
  clearDebug: () => void;
  markPromptDirty: (dirty: boolean) => void;

  // derived helpers (not in state, but provided via actions)
  getComposedPrompt: () => string;
  getCurrentScenePromptDraft: () => string;
}

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveToStorage(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota or private mode — ignore
  }
}

function loadToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(t: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (t) {
      window.sessionStorage.setItem(TOKEN_KEY, t);
    } else {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ignore
  }
}

const factoryDefaults = {
  globalTemplate: GLOBAL_SYSTEM_PROMPT,
  scenePromptDrafts: Object.fromEntries(SCENE_CARDS.map((c) => [c.id, c.scenePrompt])),
  variables: defaultVariableValues(),
  addendum: DEFAULT_ADDENDUM,
};

export const useKidsHubStore = create<KidsHubState>((set, get) => {
  // initial load (client only)
  const initialToken = loadToken();
  const savedGlobal = loadFromStorage<string>(GLOBALS_KEY, factoryDefaults.globalTemplate);
  const savedDrafts = loadFromStorage<Record<string, string>>(DRAFTS_KEY, factoryDefaults.scenePromptDrafts);
  const savedVars = loadFromStorage<Record<string, string>>(VARS_KEY, factoryDefaults.variables);
  const savedAddendum = loadFromStorage<string>(ADDENDUM_KEY, factoryDefaults.addendum);

  // ensure all cards have a draft (in case new cards added later)
  const mergedDrafts = { ...factoryDefaults.scenePromptDrafts, ...savedDrafts };

  return {
    token: initialToken,
    activeCardId: null,
    activeSectionId: null,
    globalTemplate: savedGlobal,
    scenePromptDrafts: mergedDrafts,
    variables: { ...factoryDefaults.variables, ...savedVars },
    addendum: savedAddendum,
    voiceSpeed: loadFromStorage<number>(VOICE_SPEED_KEY, 1),
    debugLog: [],
    promptDirty: false,
    lastFramingAngle: null,
    recentFactPicks: {},
    recentLoreByCard: {},

    setLastFramingAngle: (id) => set({ lastFramingAngle: id }),

    setToken: (t) => {
      saveToken(t);
      set({ token: t });
    },

    setVoiceSpeed: (n) => {
      saveToStorage(VOICE_SPEED_KEY, n);
      set({ voiceSpeed: n });
    },

    selectCard: (id) => {
      set({
        activeCardId: id,
        activeSectionId: null,
        promptDirty: true,
      });
    },

    selectSection: (id) => {
      set({
        activeSectionId: id,
        activeCardId: null,
      });
    },

    editGlobal: (text) => {
      saveToStorage(GLOBALS_KEY, text);
      set({ globalTemplate: text, promptDirty: true });
    },

    editScenePrompt: (cardId, text) => {
      set((s) => {
        const next = { ...s.scenePromptDrafts, [cardId]: text };
        saveToStorage(DRAFTS_KEY, next);
        return { scenePromptDrafts: next, promptDirty: true };
      });
    },

    editAddendum: (text) => {
      saveToStorage(ADDENDUM_KEY, text);
      set({ addendum: text, promptDirty: true });
    },

    setVariable: (key, value) => {
      set((s) => {
        const next = { ...s.variables, [key]: value };
        saveToStorage(VARS_KEY, next);
        return { variables: next, promptDirty: true };
      });
    },

    resetCard: (cardId) => {
      const card = getSceneCard(cardId);
      if (!card) return;
      set((s) => {
        const nextDrafts = { ...s.scenePromptDrafts, [cardId]: card.scenePrompt };
        saveToStorage(DRAFTS_KEY, nextDrafts);
        // also reset commander_suffix if it was the active
        const nextVars = { ...s.variables };
        if (s.activeCardId === cardId) {
          nextVars.commander_suffix = card.commanderSuffix;
        }
        saveToStorage(VARS_KEY, nextVars);
        return {
          scenePromptDrafts: nextDrafts,
          variables: nextVars,
          promptDirty: true,
        };
      });
    },

    resetAll: () => {
      // clear localStorage keys
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.removeItem(GLOBALS_KEY);
          window.localStorage.removeItem(DRAFTS_KEY);
          window.localStorage.removeItem(VARS_KEY);
          window.localStorage.removeItem(ADDENDUM_KEY);
        } catch {}
      }
      set({
        globalTemplate: factoryDefaults.globalTemplate,
        scenePromptDrafts: { ...factoryDefaults.scenePromptDrafts },
        variables: { ...factoryDefaults.variables },
        addendum: factoryDefaults.addendum,
        promptDirty: true,
      });
    },

    pushDebug: (entry) => {
      set((s) => {
        const next = [...s.debugLog, { ...entry, ts: Date.now() }];
        // cap at 200, drop oldest
        const capped = next.length > 200 ? next.slice(next.length - 200) : next;
        return { debugLog: capped };
      });
    },

    clearDebug: () => set({ debugLog: [] }),

    markPromptDirty: (dirty) => set({ promptDirty: dirty }),

    getComposedPrompt: () => {
      const s = get();
      const cardId = s.activeCardId;
      const scenePrompt = cardId ? (s.scenePromptDrafts[cardId] ?? '') : '';
      return composeSystemPrompt({
        globalTemplate: s.globalTemplate,
        scenePrompt,
        variables: s.variables,
        addendum: s.addendum,
      });
    },

    getComposedPromptSampled: () => {
      const s = get();
      const cardId = s.activeCardId;
      const scenePrompt = cardId ? (s.scenePromptDrafts[cardId] ?? '') : '';

      // 1. device_state 事实采样（原有，避重）
      const { snapshot, picks, nextRecent } = sampleDeviceState(
        s.variables.device_state ?? '',
        cardId ?? '',
        s.recentFactPicks,
      );
      set({ recentFactPicks: nextRecent });

      // 2. 世界观知识注入：L1 core + 从 CARD_LORE_MAP 按卡选 1-2 节，避开「本卡」最近用过的节
      //    （对抗审查 No.3：recentLore 按 cardId 分桶，避免夜航卡把 night_voyage 借走导致回归卡注入不到）
      const cardLoreRecent = cardId ? s.recentLoreByCard[cardId] ?? [] : [];
      const loreBundle = cardId
        ? getKnowledge(cardId, cardLoreRecent)
        : { core: '', sections: [] as LoreSection[], pickedIds: [] as string[] };
      if (cardId) {
        const nextCardRecent = [...cardLoreRecent, ...loreBundle.pickedIds].slice(-6);
        set({ recentLoreByCard: { ...s.recentLoreByCard, [cardId]: nextCardRecent } });
      }

      // 3. 组装：把 lore {core, sections} 传给 compose（L1 core 常驻；仅 sections 非空时插入本场景素材块）
      const prompt = composeSystemPrompt({
        globalTemplate: s.globalTemplate,
        scenePrompt,
        variables: { ...s.variables, device_state: snapshot },
        addendum: s.addendum,
        lore: cardId ? { core: loreBundle.core, sections: loreBundle.sections } : undefined,
      });
      return { prompt, picks, loreSections: loreBundle.sections };
    },

    getCurrentScenePromptDraft: () => {
      const s = get();
      const id = s.activeCardId;
      if (!id) return '';
      return s.scenePromptDrafts[id] ?? '';
    },
  };
});

// helper to get fresh composed without hook (for imperative send)
export function getComposedPromptNow(): string {
  const s = useKidsHubStore.getState();
  const cardId = s.activeCardId;
  const scenePrompt = cardId ? (s.scenePromptDrafts[cardId] ?? '') : '';
  return composeSystemPrompt({
    globalTemplate: s.globalTemplate,
    scenePrompt,
    variables: s.variables,
    addendum: s.addendum,
  });
}
