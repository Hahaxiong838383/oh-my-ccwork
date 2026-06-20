/**
 * 退出意图 L1 端侧告别词白名单（docs/25 问题3）—— 纯函数，~0ms。
 *
 * useMobileVoice 收到 asr.final 文本时调 detectExitIntent，命中即走退出流程。
 * 规则与 server 端 `apps/server/src/exit-intent.ts` 的 detectExitIntent 保持一致
 * （两套独立打包无法共享代码；改一处务必同步另一处。server 那份有 tsx 单测守护规则正确性）。
 *
 * 从严：只认「整句就是告别」或短句里独立含告别词，长句偶含「再见」不误触发；
 * 严格排除裸否定 不要/不/我不（"我不要吃青菜" 必放行不退出）。
 */

const EXIT_PHRASES: readonly string[] = [
  '拜拜',
  '拜拜小可',
  '小可拜拜',
  '再见',
  '再见小可',
  '小可再见',
  '不聊了',
  '不想聊了',
  '不想聊',
  '不想跟你说了',
  '不想跟你说话了',
  '不想和你说了',
  '不想和你说话了',
  '别说了',
  '你别说了',
  '我走了',
  '我要走了',
  '我要走啦',
  '我去玩了',
  '我去玩啦',
  '我要去玩了',
  '我去睡觉了',
  '我要睡觉了',
  '我去睡了',
  '先这样',
  '先这样吧',
  '就这样吧',
  '不玩了',
  '我不玩了',
  '下次再聊',
  '下次聊',
  '我先走了',
  '我先走啦',
];

const BARE_NEGATIONS: ReadonlySet<string> = new Set([
  '不',
  '不要',
  '我不',
  '我不要',
  '不行',
  '不好',
  '不是',
  '不对',
  '我不想',
  '不知道',
  '不会',
]);

/** 归一化：仅保留 CJK + 拉丁字母 + 数字，剔除标点/空白/emoji，便于整句比对。 */
export function normalizeForExit(text: string): string {
  if (!text) return '';
  return text.replace(/[^一-龥a-zA-Z0-9]/g, '');
}

/**
 * L1 告别词白名单判定：text 是否表达「想结束对话」。
 *  1) 空 → false；2) 整句为裸否定（不要/我不…）→ false（强制否）；
 *  3) 整句精确等于某告别短语 → true；
 *  4) 短句（≤8 字）包含某告别短语 → true（容"嗯拜拜啦"口语前后缀）；长句只认精确相等。
 */
export function detectExitIntent(text: string): boolean {
  const norm = normalizeForExit(text);
  if (!norm) return false;
  if (BARE_NEGATIONS.has(norm)) return false;

  for (const p of EXIT_PHRASES) {
    if (norm === p) return true;
  }
  if (norm.length <= 8) {
    for (const p of EXIT_PHRASES) {
      if (norm.includes(p)) return true;
    }
  }
  return false;
}
