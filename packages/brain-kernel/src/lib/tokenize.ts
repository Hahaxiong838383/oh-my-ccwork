/**
 * tokenize.ts — CJK bigram + Latin token 分词（brain-kernel 共享工具）
 *
 * 供 retrieval.ts / brain-context.ts / proxy-ranker.ts 统一使用，
 * 避免多份副本导致特征错位。
 */

export function tokenize(text: string): readonly string[] {
  const lower = text.toLowerCase();
  const cjkRange = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
  const cjkChars = lower.match(cjkRange) ?? [];
  const latinPart = lower.replace(cjkRange, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const latinTokens = latinPart.split(/\s+/).filter(t => t.length > 1);
  const cjkTokens: string[] = [];
  for (let i = 0; i < cjkChars.length; i++) {
    cjkTokens.push(cjkChars[i]);
    if (i + 1 < cjkChars.length) cjkTokens.push(cjkChars[i] + cjkChars[i + 1]);
  }
  return [...latinTokens, ...cjkTokens];
}
