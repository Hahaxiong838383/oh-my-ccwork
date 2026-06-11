/**
 * 小可世界观知识库 · 类型契约
 *
 * 数据源：《小可世界观知识手册 v0.3》（docs/12，team 三家精读游戏文档 + 世界观总纲整合）。
 * 设计遵循 team 架构评审的「铺路」建议——带 front-matter 元数据（sceneTags/entities），
 * 让手册将来能平滑迁移到 KG/向量检索，现在只用于 prompt 静态路由注入。
 *
 * 分层（team 评审 L1/L2 分层）：
 * - L1 WORLD_CORE：核心世界观不变量，常驻 system prompt（小可"天生就懂"）。
 * - L2 LORE_SECTIONS：场景素材库，按当前卡的 sceneTags 路由注入 1-2 节（反重复弹药）。
 */

/** L2 lore 素材节（front-matter 元数据 + 正文） */
export interface LoreSection {
  /** 稳定 ID（如 'night_voyage' 'collectibles'），将来 KG/检索的 chunk key */
  id: string;
  /** 人类可读标题 */
  title: string;
  /** 场景标签：L2 路由用（如 ['夜航','回归','宝箱']） */
  sceneTags: string[];
  /** 涉及实体 ID（指向 LORE_ENTITIES，将来 KG 抽取的关系锚点） */
  entities: string[];
  /** 给 LLM 的精炼正文（小可视角，已剔工程细节） */
  body: string;
}

/** 实体表项（统一 canonical ID 防同物异名 — team 评审建议③） */
export interface LoreEntity {
  /** canonical ID（如 'ark' 'xiaoke' 'guangling'） */
  id: string;
  /** 规范名 */
  name: string;
  /** 别名（散文里同物异名都映射到同一 id） */
  aliases: string[];
  type: 'role' | 'place' | 'item' | 'mechanic' | 'currency' | 'collectible' | 'building' | 'lore';
}

/** getKnowledge 返回（注入用，grok 注入引擎产出） */
export interface KnowledgeBundle {
  /** L1 常驻世界观（进 system prompt） */
  core: string;
  /** 本轮按场景选中的 L2 素材节 */
  sections: LoreSection[];
  /** 本轮选中的 section id（store 记录，跨轮避重） */
  pickedIds: string[];
}
