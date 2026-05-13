/**
 * 数字格式化 —— 来自 1.6 主界面数字显示规则
 *
 * - 0 ~ 999,999             → 原始整数
 * - 1,000,000 ~ 999,999,999 → "X K+"（X = 百万位向下取整）
 * - ≥ 1,000,000,000         → "999999K+" 封顶
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  const floored = Math.floor(n);
  if (floored < 1_000_000) return String(floored);
  if (floored >= 1_000_000_000) return '999999K+';
  return `${Math.floor(floored / 1_000_000)}K+`;
}
