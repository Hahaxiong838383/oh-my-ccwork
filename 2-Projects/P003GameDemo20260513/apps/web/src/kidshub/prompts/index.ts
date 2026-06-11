/**
 * KidsHub-AI Prompt 资产 · 统一出口
 *
 * 事实源：《小可 AI 产品定义》V2.0（飞书 wiki ZsI5w9N8WiUbsHkzfeicSKXRnJf）。
 * 文档地址：https://futurus.feishu.cn/wiki/ZsI5w9N8WiUbsHkzfeicSKXRnJf
 */
export { GLOBAL_SYSTEM_PROMPT } from './global-prompt';
export { SCENE_CARDS, getSceneCard } from './scene-cards';
export { PROMPT_VARIABLES, defaultVariableValues } from './variables';
export { SPEC_SECTIONS } from './sections';
export { composeSystemPrompt, fillVariables, findUnfilledPlaceholders } from './compose';
export type { SceneCard, PromptVariable, SpecSection } from './types';

/** 产品定义文档元信息（UI 出处标注用） */
export const SPEC_META = {
  docName: '《小可 AI 产品定义》',
  docVersion: 'V2.0',
  docUrl: 'https://futurus.feishu.cn/wiki/ZsI5w9N8WiUbsHkzfeicSKXRnJf',
  fetchedAt: '2026-06-11',
} as const;
