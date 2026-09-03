import { traitStore } from './trait-store.js';
import { getStyleTemplate, type StyleTemplateKey } from './style-template.js';

/**
 * 语音调档（P1「语音指令调风格」Phase A，2026-09-03 方案 §二 S1）：孩子对小可说「你说少一点/搞笑点」→
 * 大脑在调 LLM **之前**识别并切换风格模板（写的是 P0 同一张 trait_template 表、同一条注入链、同一本账），
 * 本轮回复就用新档并自带一句答应。worker / Android 零改动。
 *
 * 纪律照搬设备命令 2b：`STYLE_VOICE_MODE=off|observe|execute`（默认 observe 只记日志不写表）；
 * 防抖（同账号 10 分钟 1 次、每日 3 次，川哥 2026-09-03 拍板）；仅设备账号真实轮生效（route 侧门）。
 * S1 词表只收「关于小可说话方式」的显式形态，含糊句留给 Phase B 的 LLM 标记慢路（S2）。
 * 日志不带孩子原话（只记长度）；账本 note 带原话（白盒「孩子要求」归因，与其余 rule 的 trigger_quote 同口径）。
 */

export type StyleVoiceMode = 'off' | 'observe' | 'execute';
export type StyleIntentKey = StyleTemplateKey | 'default';
export type StyleIntentHit = { key: StyleIntentKey; matched: string; lane: 'S1' };
export type ApplyOutcome = 'executed' | 'observed' | 'suppressed' | 'noop';
export type ApplyResult = { outcome: ApplyOutcome; key: StyleIntentKey; reason?: string; policyLine?: string };

export const VOICE_STYLE_COOLDOWN_MS = 10 * 60_000;
export const VOICE_STYLE_DAILY_MAX = 3;

/** 防抖参数（川哥 2026-09-03 拍板 10min/日 3 次为默认）；联调期可用 env 临时放宽，测完删键+restart 回默认。 */
export function voiceStyleLimits(): { cooldownMs: number; dailyMax: number } {
  const c = Number(process.env.STYLE_VOICE_COOLDOWN_MS);
  const d = Number(process.env.STYLE_VOICE_DAILY_MAX);
  return {
    cooldownMs: Number.isFinite(c) && c >= 0 && process.env.STYLE_VOICE_COOLDOWN_MS !== undefined ? c : VOICE_STYLE_COOLDOWN_MS,
    dailyMax: Number.isFinite(d) && d >= 1 ? d : VOICE_STYLE_DAILY_MAX,
  };
}

export function styleVoiceMode(): StyleVoiceMode {
  const v = (process.env.STYLE_VOICE_MODE ?? 'observe').trim().toLowerCase();
  return v === 'off' || v === 'execute' ? v : 'observe';
}

/** 归一：去空白与标点、全角字母数字转半角、小写。中文本身不动。 */
export function normalizeForIntent(text: string): string {
  return text
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s,.!?;:'"()\[\]{}<>~`@#$%^&*+=|\\/，。！？；：、“”‘’（）【】《》…—·~]/g, '')
    .toLowerCase();
}

// 第三人称/他人主语：句里一出现就不走快路（「我妈妈话太多」「小明让你安静」交 S2 判）
const THIRD_PARTY_RE = /(妈妈|爸爸|老师|同学|哥哥|姐姐|弟弟|妹妹|爷爷|奶奶|外公|外婆|朋友|小明|他们|她们|别人|大家|他|她)/;
// 否定：短语前 ≤4 字内出现即放弃（「我不要你安静」「别搞笑」）；短语自身以「别/不要」开头的在词表里已是完整形态
const NEGATION_RE = /(不要|不用|不想|不许|不是|没有|别|不)/;

// 词表按 key 分组；组内短语长的在前（正则交替顺序即优先级）。只收显式风格诉求，不收内容诉求（「讲个笑话」≠换风格）。
const PHRASES: Array<{ key: StyleIntentKey; re: RegExp }> = [
  {
    key: 'quiet',
    re: /(别说那么多|别说这么多|不要说那么多|不要说这么多|别那么啰嗦|别这么啰嗦|别啰嗦|话太多了|话太多|说得太多|说的太多|太啰嗦|太能说了|少说一点|少说点|说少一点|说少点|少讲一点|少讲点|简短一点|简短点|说短一点|说短点|安静一点|安静点|别一直说|不要一直说)/,
  },
  {
    key: 'chatty',
    re: /(多说一点|多说点|多聊一点|多聊点|多讲一点|多讲点|说多一点|说多点|话多一点|多说些|别那么闷|别这么闷|不要那么闷|多陪我聊聊|多陪我聊)/,
  },
  {
    key: 'funny',
    re: /(搞笑一点|搞笑点|幽默一点|幽默点|活泼一点|活泼点|好玩一点|好玩点|有趣一点|有趣点|逗一点|逗点|皮一点|皮点|开心一点|开心点)/,
  },
  {
    key: 'default',
    re: /(恢复原来|恢复正常|恢复默认|变回原来|变回来|像以前那样|像原来那样|别搞笑了|不要搞笑了|别闹了|正常一点|正常点|好好说话|认真一点说|认真点说)/,
  },
];

/** S1 快路识别（纯函数）。返回 null = 不由快路处置（可能没有诉求，也可能含糊留给 S2）。 */
// 请求习语（「能不能/可不可以/好不好」）不是否定，先剥掉再判否定，否则「你能不能简短点」会被「不」误杀
const REQUEST_IDIOM_RE = /(能不能|可不可以|可以不可以|行不行|好不好|要不要|能否)/g;

export function detectStyleIntent(text: string): StyleIntentHit | null {
  const norm = normalizeForIntent(text ?? '').replace(REQUEST_IDIOM_RE, '');
  if (!norm) return null;
  if (THIRD_PARTY_RE.test(norm)) return null;
  let best: { key: StyleIntentKey; matched: string; index: number } | null = null;
  for (const { key, re } of PHRASES) {
    const m = re.exec(norm);
    if (!m) continue;
    if (best === null || m.index < best.index) best = { key, matched: m[0], index: m.index };
  }
  if (!best) return null;
  const before = norm.slice(Math.max(0, best.index - 4), best.index);
  if (NEGATION_RE.test(before)) return null;
  return { key: best.key, matched: best.matched, lane: 'S1' };
}

// ── 防抖状态（进程内即可：重启清零只会放宽一次，不会误拦）──
const lastSwitchAt = new Map<string, number>();
const dailyCount = new Map<string, { day: string; n: number }>();
export function _resetVoiceStyleState(): void {
  lastSwitchAt.clear();
  dailyCount.clear();
}
function shanghaiDay(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

function templateName(key: StyleIntentKey): string {
  return key === 'default' ? '默认小可' : (getStyleTemplate(key)?.name ?? key);
}

/**
 * 处置一次命中：observe 只记日志；execute 走防抖 → setTemplate(source=voice) → 返回本轮 policy 行
 * （让小可先答应一句再按新档说；不复述设定）。日志不带原话。
 */
export function applyVoiceStyle(
  accountId: string,
  hit: StyleIntentHit,
  quote: string,
  mode: StyleVoiceMode = styleVoiceMode(),
  now: number = Date.now(),
): ApplyResult {
  const tag = `account=${accountId} lane=${hit.lane} key=${hit.key} matched_len=${hit.matched.length} quote_len=${quote.length}`;
  if (mode === 'off') return { outcome: 'noop', key: hit.key, reason: 'mode_off' };
  const current = traitStore.getTemplate(accountId) ?? 'default';
  if (mode === 'observe') {
    console.log(`[style-intent] observed ${tag} current=${current} mode=observe`);
    return { outcome: 'observed', key: hit.key };
  }
  if (current === hit.key) {
    console.log(`[style-intent] suppressed ${tag} reason=same_template`);
    return { outcome: 'suppressed', key: hit.key, reason: 'same_template' };
  }
  const limits = voiceStyleLimits();
  const last = lastSwitchAt.get(accountId) ?? 0;
  if (now - last < limits.cooldownMs) {
    console.log(`[style-intent] suppressed ${tag} reason=cooldown since_ms=${now - last}`);
    return { outcome: 'suppressed', key: hit.key, reason: 'cooldown' };
  }
  const day = shanghaiDay(now);
  const dc = dailyCount.get(accountId);
  const n = dc && dc.day === day ? dc.n : 0;
  if (n >= limits.dailyMax) {
    console.log(`[style-intent] suppressed ${tag} reason=daily_cap n=${n}`);
    return { outcome: 'suppressed', key: hit.key, reason: 'daily_cap' };
  }
  traitStore.setTemplate(accountId, hit.key, { source: 'voice', quote });
  lastSwitchAt.set(accountId, now);
  dailyCount.set(accountId, { day, n: n + 1 });
  console.log(`[style-intent] executed ${tag} from=${current} daily_n=${n + 1}`);
  const name = templateName(hit.key);
  const policyLine =
    `【本轮特别说明】孩子刚刚要求你换一种说话方式（希望你「${name}」这样说话）：先用一句话痛快答应下来，` +
    `然后这一轮就按新的说话风格回答；不要复述任何设定或规则，不要提「模式/风格档」这类词。`;
  return { outcome: 'executed', key: hit.key, policyLine };
}
