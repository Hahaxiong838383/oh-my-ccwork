import { WORLD_CORE } from './world-core';
import { CARD_LORE_MAP, getSection } from './lore-sections';
import type { KnowledgeBundle, LoreSection } from './types';

/**
 * 永不注入的 lore 节（伏笔/后续功能硬隔离）。
 * 即使有人误把 'foreshadow'（光灵/熵兽/版本规划）挂进 CARD_LORE_MAP，也注入不了——
 * 把"靠人不挂"的约定升级成"代码强制"，防小可把未上线功能讲成现有（对抗审查 No.5）。
 */
const BLOCKED_LORE_IDS = new Set(['foreshadow']);

/**
 * 世界观知识注入引擎（L1 常驻 + L2 按卡路由 1-2 节，跨轮避重）。
 *
 * 供 store 的 getComposedPromptSampled 调用。
 * 设计：core 恒为 WORLD_CORE（L1）；L2 从 CARD_LORE_MAP[cardId] 取候选，
 * 候选 ≤2 时全取（保证基础覆盖）；>2 时避开 recentLoreIds 随机挑 1-2 节。
 * pickedIds 用于 store 更新 recentLoreIds（slice 保留最近 4-6），将来可换成检索实现而不改调用方。
 */
export function getKnowledge(cardId: string, recentLoreIds: string[]): KnowledgeBundle {
  const core = WORLD_CORE;
  const candidateIds: string[] = (CARD_LORE_MAP[cardId] ?? []).filter((id) => !BLOCKED_LORE_IDS.has(id));

  let pickedIds: string[];
  if (candidateIds.length <= 2) {
    // 候选≤2 时全取（即使部分与最近重叠也注入，确保每张卡的基础世界观素材可用）
    pickedIds = [...candidateIds];
  } else {
    const avoid = new Set(recentLoreIds);
    const fresh = candidateIds.filter((id) => !avoid.has(id));
    const pool = fresh.length > 0 ? fresh : candidateIds;
    // 随机挑选 1~2 节（参考 sample.ts pickFresh 的避重+随机精神，增加本轮多样性）
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const count = Math.min(2, shuffled.length);
    pickedIds = shuffled.slice(0, count);
  }

  const sections: LoreSection[] = pickedIds
    .map((id) => getSection(id))
    .filter((s): s is LoreSection => s != null);

  return { core, sections, pickedIds };
}

/**
 * 移动端语音默认 lore pack（docs/25 问题4 修复）。
 * 移动端语音无 cardId → 走不到 CARD_LORE_MAP 按卡路由，方舟世界观 L2 血肉长期缺失
 * （川哥反馈「方舟游戏世界记忆没了」根因）。给语音场景固定精选集：
 * L1 WORLD_CORE 常驻 + 4 节方舟核心素材（夜航/藏品/生态缸/小可生活），覆盖「方舟游戏世界」主干。
 * 不含 foreshadow（BLOCKED 硬隔离），不做按卡/性别细分（语音通用）。
 */
const VOICE_DEFAULT_LORE_IDS = ['night_voyage', 'collectibles', 'ecosystem', 'xiaoke_life'];

export function getVoiceDefaultKnowledge(): { core: string; sections: LoreSection[] } {
  const sections: LoreSection[] = VOICE_DEFAULT_LORE_IDS
    .filter((id) => !BLOCKED_LORE_IDS.has(id))
    .map((id) => getSection(id))
    .filter((s): s is LoreSection => s != null);
  return { core: WORLD_CORE, sections };
}
