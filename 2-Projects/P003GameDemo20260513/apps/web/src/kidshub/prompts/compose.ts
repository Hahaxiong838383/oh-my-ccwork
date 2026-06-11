/**
 * Prompt 组装 · 《小可 AI 产品定义》落地建议「Prompt 用法」的实现
 *
 * 组装顺序：全局模板的 {scene_prompt} ← 场景子 Prompt → 尾部拼接工程附加规则，
 * 再统一替换变量占位符（场景子 Prompt 内部的 {nickname} 等也在第二步一并替换）。
 * 组装结果即真实下发 server / LLM 的 system prompt——所见即所发。
 */
export function composeSystemPrompt(opts: {
  globalTemplate: string;
  scenePrompt: string;
  variables: Record<string, string>;
  /** 工程附加规则（防示例复读 + KidsHub 全局响应），空串 = 关闭 */
  addendum?: string;
}): string {
  const withScene = opts.globalTemplate.split('{scene_prompt}').join(opts.scenePrompt);
  const addendum = opts.addendum?.trim();
  const full = addendum ? `${withScene}\n\n${addendum}` : withScene;
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
