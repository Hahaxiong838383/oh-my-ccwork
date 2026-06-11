import type { SceneId } from '../../store/app-store';

/**
 * KidsHub-AI Prompt 工作台 · 数据类型
 *
 * 事实源：《小可 AI 产品定义》V2.0（飞书 ZsI5w9N8WiUbsHkzfeicSKXRnJf，2026-06-07）。
 * 所有 prompt 原文逐字搬运，不得在代码里改写产品话术；改动走产品定义文档再同步回来。
 */

/** 运行时占位符（产品定义 B.2 约定表） */
export interface PromptVariable {
  /** 占位符 key，模板中以 {key} 出现 */
  key: string;
  /** 中文名 */
  label: string;
  /** 来源说明（产品定义 B.2 原文） */
  source: string;
  /** demo 默认 mock 值（与场景卡示例话术对账一致） */
  defaultValue: string;
  /** device_state 这类 JSON 用多行编辑 */
  multiline?: boolean;
}

/** 八张场景卡（产品定义 B.3） */
export interface SceneCard {
  /** 'card1' ~ 'card8' */
  id: string;
  /** 卡号 1-8（沿用产品定义 B.3 原编号） */
  cardNo: number;
  /** 卡名，如「登舰破冰」 */
  title: string;
  /** 产品定义 B.3 卡标题中的功能号出处，如「功能 5」；无则空串 */
  funcRef: string;
  /** 本轮目标 */
  goal: string;
  /** 必须做 */
  must: string[];
  /** 禁止做 */
  forbidden: string[];
  /** 产品逻辑依据（原文「为什么」） */
  why: string;
  /** 场景子 Prompt 原文（填入全局模板 {scene_prompt}） */
  scenePrompt: string;
  /** 进入该卡时画布跳转的场景；null = 保持当前画面 */
  sceneId: SceneId | null;
  /** 该场景 {commander_suffix} 推荐值（产品定义场景判定） */
  commanderSuffix: 'on' | 'off';
  /**
   * 进卡开场白模板（小可先说，走 sayDirect，支持 {占位符}）。
   * null = 该场景由孩子先开口，AI 不先说话。
   */
  opening: string | null;
  /** 开场白性质说明（产品话术 / 演示用占位），UI 展示 */
  openingNote?: string;
  /** 工作台提示：建议对小可说什么来体验本卡 */
  hint: string;
}

/** B.0 / B.1 / B.4 / B.5 / B.6 版块阅读数据 */
export interface SpecSection {
  /** 'b0' | 'b1' | 'b4' | 'b5' | 'b6' */
  id: string;
  title: string;
  /** 原文要点（markdown，供左栏阅读页渲染） */
  body: string;
}
