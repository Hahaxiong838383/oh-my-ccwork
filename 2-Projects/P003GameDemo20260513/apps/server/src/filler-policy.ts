import { configStore } from './config-store.js';
import { traitStore } from './trait-store.js';

export const FILLER_STYLES = ['default', 'chatty', 'quiet', 'funny'] as const;
export type FillerStyle = typeof FILLER_STYLES[number];
export type FillerProbabilities = Record<FillerStyle, number>;
export const FILLER_POLICY_KEY = 'xiaoke.filler_style_probability';
const DEFAULTS: FillerProbabilities = { default: 0.25, chatty: 0.45, quiet: 0.10, funny: 0.35 };

export function validFillerProbabilities(value: unknown): value is FillerProbabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).length === FILLER_STYLES.length && FILLER_STYLES.every(k =>
    Object.hasOwn(obj, k) && typeof obj[k] === 'number' && Number.isFinite(obj[k]) && obj[k] >= 0 && obj[k] <= 1);
}
export function getFillerStyleSettings() {
  const flag = configStore.getFlag(FILLER_POLICY_KEY);
  let probabilities = { ...DEFAULTS };
  let source: 'default' | 'override' = 'default';
  try {
    const value: unknown = flag ? JSON.parse(flag.value) : null;
    if (validFillerProbabilities(value)) { probabilities = value; source = 'override'; }
  } catch { /* Invalid manual DB edits fall back to conservative defaults. */ }
  return { probabilities, source, effective: 'next_session' as const };
}
export function saveFillerStyleSettings(value: unknown, updatedBy: string) {
  if (!validFillerProbabilities(value)) throw new Error('四种风格的概率须为 0 到 1 的数字，不能缺项或增加未知项');
  configStore.setFlag(FILLER_POLICY_KEY, JSON.stringify(value), updatedBy, 'Worker 衔接短语；新会话生效');
  return getFillerStyleSettings();
}
export function buildFillerPolicy(accountId?: string | null) {
  const chosen = accountId ? traitStore.getTemplate(accountId) : null;
  const style: FillerStyle = FILLER_STYLES.includes(chosen as FillerStyle) ? chosen as FillerStyle : 'default';
  return { version: 1 as const, style, probability: getFillerStyleSettings().probabilities[style] };
}
