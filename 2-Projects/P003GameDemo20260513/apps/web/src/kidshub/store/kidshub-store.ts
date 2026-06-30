import { create } from 'zustand';
import {
  GLOBAL_SYSTEM_PROMPT,
  DEFAULT_ADDENDUM,
  SCENE_CARDS,
  getSceneCard,
  defaultVariableValues,
  composeSystemPrompt,
  PROMPT_VARIABLES,
} from '../prompts';
import { sampleDeviceState } from '../prompts/sample';
import { getKnowledge, getVoiceDefaultKnowledge } from '../knowledge/get-knowledge';
import type { LoreSection } from '../knowledge/types';
import { KNOWLEDGE_META, WORLD_CORE } from '../knowledge';

const TOKEN_KEY = 'kidshub.token';
const DRAFTS_KEY = 'kidshub.scenePromptDrafts';
// 出厂 prompt 变更时 bump key 让旧 localStorage 缓存失效
// （否则老用户的缓存会盖住新出厂值，永远拿不到新指令）
// globalTemplate.v5：【称呼】再注入 {age}（登录页收集孩子年龄，让小可按年龄把握用词深浅，不拿年龄施压）
// globalTemplate.v4：【称呼】注入 {gender}（登录页收集孩子性别，让小可知道但不贴性别标签）
// globalTemplate.v3：世界观+读写台玻璃光学原理（画面在 3 米外，护眼根本逻辑）
// addendum.v5：规则 8 收紧——参照物只许"读写台玻璃"，去掉"书本"（川哥钦定 2026-06-13）
const GLOBALS_KEY = 'kidshub.globalTemplate.v5';
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

/** 拼接可视化：单层数据（含原文 + 来源说明 + 字符数） */
export interface AssemblyLayer {
  /** 稳定 key，用于 UI 颜色映射 */
  key: 'global' | 'scene' | 'addendum' | 'loreCore' | 'loreSections' | 'variables';
  /** 中文展示标签 */
  label: string;
  /** 来源说明（文件路径 / 数据源） */
  source: string;
  /** 原文（未变量替换；variables 层为表格序列化） */
  rawText: string;
  /** 字符数（rawText.length） */
  charCount: number;
  /** UI 高亮色（tailwind class 直接用） */
  accentClass: string;
  /** 一句话给新同事的说明 */
  hint: string;
}

/** 变量替换记录：本轮哪些变量被注入了什么值 + 是否本轮采样改写过 */
export interface VariableSubstitution {
  key: string;
  label: string;
  value: string;
  /** 本轮事实采样改写了它（device_state 等） */
  sampledThisTurn: boolean;
}

/** 引导可视化：单步快照（与场景卡 LastAssembly 并存，两者互斥/共存皆可） */
export interface TutorialStepAssembly {
  unitId: string;
  unitTitle: string;
  unitEmoji: string;
  stepIndex: number;
  /** 该单元总步数 */
  stepTotal: number;
  /** 当前步骤详情 */
  step: {
    id: string;
    specStep: string;
    expression: string;
    target: string | null;
    targetDescription: string | null;
    /** 注入 {child_nickname} 后的旁白（实际播放文本） */
    voiceCopy: string | null;
    /** 旁白原文（未注入），方便看占位符位置 */
    voiceCopyRaw: string | null;
    durationMs: number | null;
    remindCopy: string | null;
    waitFor: string | null;
    hideAvatar: boolean;
    scene: string | null;
    sound: string | null;
    isUnitEnd: boolean;
    /** ASR 推进关键词（hintsForTarget(waitFor)） */
    advanceHints: string[];
    /** LLM 兜底 system prompt（buildTutorialSystemPrompt(step) 全文） */
    systemPrompt: string;
  };
  /** 当前阶段：speaking / waiting / celebrating / handoff */
  phase: 'speaking' | 'waiting' | 'celebrating' | 'handoff';
  remindCount: number;
  /** 引导期会话元数据：kidshub 单元=feedback，其他=off */
  captureMode: 'off' | 'feedback';
  /** 注入用的孩子昵称（与场景卡同 store.variables.nickname；默认"指挥官"） */
  nickname: string;
  timestamp: number;
}

/** 拼接可视化：选卡触发后整条流水线的完整快照 */
export interface LastAssembly {
  cardId: string;
  cardNo: number;
  cardTitle: string;
  /** device_state 等本轮采样选中的事实（按字段名 → 选中文本） */
  picks: Record<string, string>;
  /** L2 lore 本轮选中的节 */
  loreSections: LoreSection[];
  /** 本卡最近用过的 lore id（避重展示用） */
  loreRecentReuse: string[];
  /** 本轮 framing 角度 */
  angle: { id: string; label: string; hint: string } | null;
  /** 6 层有序快照（按组装顺序） */
  layers: AssemblyLayer[];
  /** 变量替换表（本轮注入） */
  variableSubstitutions: VariableSubstitution[];
  /** 最终下发给 server 的完整 system prompt（变量已替换） */
  finalPrompt: string;
  /** 触发时间戳（用于 UI 检测新触发触发瀑布流动画） */
  timestamp: number;
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

  // 拼接可视化：选卡瞬间的完整流水线快照（getComposedPromptSampled 内部写入；StudioPage 选卡副作用补 angle）
  lastAssembly: LastAssembly | null;
  setLastAssemblyAngle: (angle: { id: string; label: string; hint: string }) => void;

  // 引导可视化：当前步骤快照（TutorialManager 副作用写入；引导退出 → null）
  lastTutorialStep: TutorialStepAssembly | null;
  setLastTutorialStep: (snapshot: TutorialStepAssembly) => void;
  updateTutorialPhase: (phase: TutorialStepAssembly['phase'], remindCount: number) => void;
  clearLastTutorialStep: () => void;

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
    lastAssembly: null,
    lastTutorialStep: null,

    setLastAssemblyAngle: (angle) => {
      set((s) => {
        if (!s.lastAssembly) return s;
        return { lastAssembly: { ...s.lastAssembly, angle } };
      });
    },

    setLastTutorialStep: (snapshot) => set({ lastTutorialStep: snapshot }),

    updateTutorialPhase: (phase, remindCount) => {
      set((s) => {
        if (!s.lastTutorialStep) return s;
        // 只 phase / remindCount 变化时打个新 timestamp，保留 step 主体
        return {
          lastTutorialStep: {
            ...s.lastTutorialStep,
            phase,
            remindCount,
            timestamp: Date.now(),
          },
        };
      });
    },

    clearLastTutorialStep: () => set({ lastTutorialStep: null }),

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
      const mergedVars: Record<string, string> = { ...s.variables, device_state: snapshot };
      const prompt = composeSystemPrompt({
        globalTemplate: s.globalTemplate,
        scenePrompt,
        variables: mergedVars,
        addendum: s.addendum,
        lore: cardId ? { core: loreBundle.core, sections: loreBundle.sections } : undefined,
      });

      // 4. 拼接可视化快照（angle 由 StudioPage 在选完角度后通过 setLastAssemblyAngle 补上）
      if (cardId) {
        const card = getSceneCard(cardId);
        const layers: AssemblyLayer[] = [
          {
            key: 'global',
            label: '① 全局 System Prompt',
            source: 'prompts/global-prompt.ts · GLOBAL_SYSTEM_PROMPT',
            rawText: s.globalTemplate,
            charCount: s.globalTemplate.length,
            accentClass: 'border-sky-400/50 bg-sky-500/10 text-sky-100',
            hint: '小可的世界观底座（含 {scene_prompt} 占位 + 称呼/角色/红线）。每张卡都用同一份。',
          },
          {
            key: 'scene',
            label: `② 场景子 Prompt · ${card?.title ?? cardId}`,
            source: `prompts/scene-cards.ts · card${card?.cardNo ?? '?'}`,
            rawText: scenePrompt,
            charCount: scenePrompt.length,
            accentClass: 'border-emerald-400/50 bg-emerald-500/10 text-emerald-100',
            hint: '替换全局模板里的 {scene_prompt} 占位。八张卡各自不同——核心是当前这张。',
          },
          {
            key: 'addendum',
            label: '③ 工程附加规则（addendum）',
            source: 'prompts/addendum.ts · DEFAULT_ADDENDUM',
            rawText: s.addendum,
            charCount: s.addendum.length,
            accentClass: 'border-amber-400/50 bg-amber-500/10 text-amber-100',
            hint: '非产品定义原文：句级表情标记、防示例复读、KidsHub 全局响应。空 = 关闭。',
          },
          {
            key: 'loreCore',
            label: '④ 世界观 L1 核心（常驻）',
            source: 'knowledge/world-core.ts · WORLD_CORE',
            rawText: `${KNOWLEDGE_META.boundaryDeclaration}\n\n${WORLD_CORE}`,
            charCount: WORLD_CORE.length + KNOWLEDGE_META.boundaryDeclaration.length + 2,
            accentClass: 'border-violet-400/50 bg-violet-500/10 text-violet-100',
            hint: '每张卡都注入，让小可"天生就懂"方舟世界。开头一行死活分离声明防 LLM 把"存在"讲成"拥有"。',
          },
          {
            key: 'loreSections',
            label: `⑤ 世界观 L2 本场景素材（本轮 ${loreBundle.sections.length} 节）`,
            source: `knowledge/lore-sections.ts · CARD_LORE_MAP[${cardId}] → ${loreBundle.sections.map((x) => x.id).join(',') || '∅'}`,
            rawText: loreBundle.sections.length === 0
              ? '（本卡未路由任何 L2 素材）'
              : loreBundle.sections.map((sec) => `【${sec.title}】(${sec.id})\n${sec.body}`).join('\n\n'),
            charCount: loreBundle.sections.reduce((n, sec) => n + sec.body.length + sec.title.length, 0),
            accentClass: 'border-fuchsia-400/50 bg-fuchsia-500/10 text-fuchsia-100',
            hint: '按卡路由 1-2 节素材（CARD_LORE_MAP 候选 → 避重随机挑）。本卡最近用过的节这轮回避。',
          },
          {
            key: 'variables',
            label: '⑥ 变量替换（{key} → 值）',
            source: 'prompts/variables.ts · PROMPT_VARIABLES',
            rawText: Object.entries(mergedVars)
              .map(([k, v]) => `{${k}} → ${v || '(空)'}`)
              .join('\n'),
            charCount: Object.entries(mergedVars).reduce((n, [k, v]) => n + k.length + (v?.length ?? 0), 0),
            accentClass: 'border-orange-400/50 bg-orange-500/10 text-orange-100',
            hint: '把上面 5 层里的 {nickname} {age} {device_state} 等占位换成真值。device_state 等多条事实采样轮换防重复。',
          },
        ];

        const variableSubstitutions: VariableSubstitution[] = PROMPT_VARIABLES.map((v) => ({
          key: v.key,
          label: v.label,
          value: mergedVars[v.key] ?? '',
          sampledThisTurn: Object.prototype.hasOwnProperty.call(picks, v.key),
        }));

        set({
          lastAssembly: {
            cardId,
            cardNo: card?.cardNo ?? 0,
            cardTitle: card?.title ?? cardId,
            picks,
            loreSections: loreBundle.sections,
            loreRecentReuse: cardLoreRecent,
            angle: null,
            layers,
            variableSubstitutions,
            finalPrompt: prompt,
            timestamp: Date.now(),
          },
        });
      }

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

// 移动端语音专用组装（docs/25 问题4 记忆修复）：在 getComposedPromptNow 基础上带上方舟世界观 lore
// （L1 WORLD_CORE 常驻 + 语音默认精选 L2），修复移动端语音「方舟游戏世界记忆缺失」根因。
// 不复用 getComposedPromptNow（体验台 StudioPage 预览/复制也用它，保持其行为不变）。
export function getMobileVoicePromptNow(): string {
  const s = useKidsHubStore.getState();
  const cardId = s.activeCardId;
  const scenePrompt = cardId ? (s.scenePromptDrafts[cardId] ?? '') : '';
  return composeSystemPrompt({
    globalTemplate: s.globalTemplate,
    scenePrompt,
    variables: s.variables,
    addendum: s.addendum,
    lore: getVoiceDefaultKnowledge(),
  });
}
