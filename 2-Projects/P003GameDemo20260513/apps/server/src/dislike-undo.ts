/**
 * 「不喜欢」语音撤回（2026-09-03 川哥拍板：不喜欢要能撤回）。
 *
 * 现状：「我不喜欢X了」→ preference「不喜欢X」+ 从兴趣删 X（2026-08-23 方案 B），此后 X 再被抽成兴趣
 * 一律被 dislike 对撞拦下——单向门：孩子改口「我又喜欢X了」没有任何路径能撤回，只剩家长端删条目。
 *
 * 撤回门（模式同改称呼硬门：LLM 只交候选 + 照抄原话的 evidence，服务端机验）：
 *   ① evidence 必须是孩子【本轮】消息的真实连续子串——滑窗重抽（设备房每轮抽最近 3 轮）只会在
 *      那句话是本轮时触发一次，不会在后面两轮里反复撤回/复活；
 *   ② 本轮整句无否定（不喜欢/讨厌/别/不要…）——LLM 从「我不喜欢恐龙了」里抄出「喜欢恐龙」照样拒；
 *   ③ evidence 含明确「喜欢」类表达；④ value 归一后必须出现在 evidence 里。
 * 对称路径：撤回过的「不喜欢X」按 UNIQUE(account,type,content) 无法重插，孩子本轮又明确说不喜欢时
 * 按原 content 复活（isFreshDislikeStatement 同样只认本轮原话）。
 */
import { isSameInterest, normalizeInterestValue } from './profile-store.js';
import { clipText, type GateTurn } from './rename-gate.js';

export type Relike = { value: string; evidence: string };

/** 明确的「喜欢」表达（evidence 里必须出现）。 */
const LIKE_RE = /喜欢|爱|想玩|想看|想听|想聊|想要|想学|想再/;
/** 本轮整句含否定/厌恶即拒——误撤回=把孩子讨厌的东西重新当兴趣，代价高于漏撤（孩子再说一遍即可）。 */
const NEGATIVE_RE = /不喜欢|不爱|讨厌|不想|不要|不太|不怎么|没那么|不再|别|烦|不喜|不是很|没有那么/;
/** 本轮又明确说不喜欢（复活撤回过的条目用）。 */
const DISLIKE_RE = /不喜欢|讨厌|不想|不要|烦|不爱|不玩|不看|不听|不再/;

/** 从 LLM 输出的 relikes 里筛出过门的（纯函数，供单测）。 */
export function parseRelikes(obj: Record<string, unknown>, history: GateTurn[]): Relike[] {
  const raw = obj.relikes;
  if (!Array.isArray(raw)) return [];
  const lastUser = [...history].reverse().find((t) => t.role === 'user')?.content ?? '';
  if (!lastUser || NEGATIVE_RE.test(lastUser)) return [];
  const out: Relike[] = [];
  for (const it of raw.slice(0, 3)) {
    if (!it || typeof it !== 'object') continue;
    const o = it as { value?: unknown; evidence?: unknown };
    const value = typeof o.value === 'string' ? clipText(o.value, 20) : '';
    const ev = typeof o.evidence === 'string' ? clipText(o.evidence, 50) : '';
    if (!value || ev.length < 2) continue;
    if (!lastUser.includes(ev)) continue; // ①只认本轮原话
    if (!LIKE_RE.test(ev)) continue; // ③
    const nv = normalizeInterestValue(value);
    if (!nv || !normalizeInterestValue(ev).includes(nv)) continue; // ④
    if (out.some((r) => isSameInterest(r.value, value))) continue;
    out.push({ value, evidence: ev });
  }
  return out;
}

/** 孩子本轮是否又明确说了不喜欢 X（撤回过的不喜欢只有拿到新鲜原话才复活）。 */
export function isFreshDislikeStatement(lastUserText: string, value: string): boolean {
  if (!lastUserText || !DISLIKE_RE.test(lastUserText)) return false;
  const nv = normalizeInterestValue(value);
  return !!nv && normalizeInterestValue(lastUserText).includes(nv);
}

/** 「不喜欢X」条目 content → X（preference 条目的 content 形态由 parseEpisodic 固定为「不喜欢」前缀）。 */
export function dislikeSubject(content: string): string {
  return content.replace(/^不喜欢/, '');
}
