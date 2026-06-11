/**
 * 小可世界观知识库 · 统一出口
 *
 * 数据源：《小可世界观知识手册 v0.3》（docs/12-小可世界观知识手册.md）。
 * 分层：L1 WORLD_CORE 常驻 system prompt；L2 LORE_SECTIONS 按场景路由注入。
 * getKnowledge（注入引擎）见 ./get-knowledge.ts。
 */
export type { LoreSection, LoreEntity, KnowledgeBundle } from './types';
export { WORLD_CORE } from './world-core';
export { LORE_SECTIONS, CARD_LORE_MAP, getSection } from './lore-sections';
export { LORE_ENTITIES, getEntity } from './lore-entities';

/** 知识库元信息（工作台出处标注 + 死活分离声明用） */
export const KNOWLEDGE_META = {
  source: '《小可世界观知识手册》',
  version: 'v0.3',
  docPath: 'docs/12-小可世界观知识手册.md',
  feishuUrl: 'https://futurus.feishu.cn/wiki/Hb8Wwe9JviD0NKkUbOvcF786nMc',
  /** 死/活分离声明：注入 prompt 时置于 lore 块开头，明确"静态世界设定 vs 动态实时状态" */
  boundaryDeclaration:
    '以下是《小可世界观知识手册》里的世界设定，只用于理解世界里存在什么机制和素材。任何实时数值、此刻/今天的变化、已锁定收益必须严格来自 device_state；与《小可 AI 产品定义》冲突时以产品定义为准；绝不把标「后续/伏笔」的内容讲成现有，绝不编造 device_state 里没有的事实。',
} as const;
