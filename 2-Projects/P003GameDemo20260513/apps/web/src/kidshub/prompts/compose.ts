/**
 * Prompt 组装 · 《小可 AI 产品定义》落地建议「Prompt 用法」的实现
 *
 * 组装顺序：全局模板的 {scene_prompt} ← 场景子 Prompt → 尾部拼接工程附加规则，
 * 再统一替换变量占位符（场景子 Prompt 内部的 {nickname} 等也在第二步一并替换）。
 * 组装结果即真实下发 server / LLM 的 system prompt——所见即所发。
 *
 * 新增 lore 支持：世界观知识库注入（L1 core 常驻 + L2 场景素材），
 * 在 addendum 之后、变量替换之前插入对应块，boundaryDeclaration 置于核心块开头做死活分离。
 */
import type { LoreSection } from '../knowledge/types';
import { KNOWLEDGE_META } from '../knowledge';

export function composeSystemPrompt(opts: {
  globalTemplate: string;
  scenePrompt: string;
  variables: Record<string, string>;
  /** 工程附加规则（防示例复读 + KidsHub 全局响应），空串 = 关闭 */
  addendum?: string;
  /** 世界观知识（L1 core + 本轮选中的 L2 sections），可选；由 getKnowledge 提供 */
  lore?: { core: string; sections: LoreSection[] };
}): string {
  const withScene = opts.globalTemplate.split('{scene_prompt}').join(opts.scenePrompt);
  const addendum = opts.addendum?.trim();
  let full = addendum ? `${withScene}\n\n${addendum}` : withScene;

  // 世界观知识注入（addendum 之后、变量替换之前）——不破坏 {scene_prompt} 与变量替换流程
  if (opts.lore) {
    const { core, sections = [] } = opts.lore;
    if (core) {
      const boundary = KNOWLEDGE_META.boundaryDeclaration;
      full += `\n\n【世界观·核心】\n${boundary}\n${core}`;
    }
    if (sections.length > 0) {
      const loreMat = sections.map((s) => `${s.title}：${s.body}`).join('\n\n');
      // 危险素材（具体藏品/光环/生态缸演变）紧贴用户消息、recency 最强，块内必须再贴一道强边界 + 正反例，
      // 否则 LLM 易把"世界里存在"讲成"孩子此刻拥有"（对抗审查 No.1，最高风险）
      full += `\n\n【世界观·本场景素材】（以下只是这个世界里"存在"的设定，不代表孩子此刻就拥有——凡涉及"你的/今天/刚刚/现在"的事实，一律以上文 device_state 为准。✅可以说"方舟世界里有机械恐龙这种藏品"；❌不能说"你昨晚的宝箱里有机械恐龙"。）\n${loreMat}`;
    }
  }

  return fillVariables(full, opts.variables);
}

/** 替换文本中的 {key} 占位符（不含 {scene_prompt}） */
export function fillVariables(template: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    template,
  );
}

/** 找出文本中残留未替换的 {xxx} 占位符（编辑预览时提示用） */
export function findUnfilledPlaceholders(text: string): string[] {
  const matches = text.match(/\{[a-z_]+\}/g);
  return matches ? [...new Set(matches)] : [];
}
