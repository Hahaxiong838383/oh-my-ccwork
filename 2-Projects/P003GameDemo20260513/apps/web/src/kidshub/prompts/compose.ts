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

/**
 * 火山 RTC「实时对话」净化：剔除对火山不生效且有害的内容（句级表情标记指令）。
 * WS pipeline 靠 server 剥离 LLM 输出的【表情：xxx】驱动 avatar；但 custom-llm 不剥离，
 * 火山直接 TTS 会把「表情：吃惊」念出来污染语音。仅工作台「实时对话」触发时用，
 * 其他场景（WS pipeline / 手机端 / live 固定大脑）prompt 一律不变。
 * 策略：行级删表情标记规则（addendum 第5条 + 正/反例）+ 末尾追加强禁令兜底
 *      （近因效应，即使没删净也不输出标记）。第6条「不描述外观」对 RTC 仍有效，保留。
 */
export function sanitizeForVolcRtc(prompt: string): string {
  const kept = prompt.split('\n').filter((line) => {
    const t = line.trim();
    if (/句级表情标记/.test(t)) return false; // addendum 第5条主体
    if (/^正例[：:]/.test(t) && t.includes('【')) return false; // 表情正例
    if (/^反例[：:]/.test(t) && t.includes('【')) return false; // 表情反例
    return true;
  });
  return (
    kept.join('\n') +
    '\n\n【实时语音模式·最高优先】你现在是实时语音对话，说的每个字都会被直接读给孩子听。' +
    '绝对不要输出【表情：xxx】、任何方括号【】标记或舞台提示，只说要对孩子讲的话本身，不带任何标记符号。'
  );
}
