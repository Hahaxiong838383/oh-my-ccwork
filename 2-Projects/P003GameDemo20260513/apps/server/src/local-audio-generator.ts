import crypto from 'node:crypto';
import { callExtractionLlm } from './llm-extract.js';
import { isCrisisContent } from './memory-safety-filter.js';
import { relationStateStore, familiarityTier, personaLocalAudioEnabled } from './relation-state-store.js';
import { traitStore, TRAIT_DIMS, TRAIT_LABELS, TRAIT_BASELINE, type TraitDim } from './trait-store.js';
import { getStyleTemplate } from './style-template.js';
import { growthLedgerStore } from './growth-ledger-store.js';
import { localAudioStore, LOCAL_AUDIO_SLOTS, REQUIRED_SLOTS, MIN_ITEMS_PER_SLOT, type LocalAudioSlot } from './local-audio-store.js';
import { synthesizeXfyunTtsWav } from './providers/xfyun-tts.js';
import { activeDeviceReplyKeep } from './local-audio-device-reply.js';
import { configStore } from './config-store.js';

/**
 * 本地人格音频生成器（合同 v1.1 §5/§6 + codex 回执四修订）。
 *
 * 每日批检查（挂 insight-runner runDailyPersonaJobs），满足任一才重生成：
 * 首轮 / 距上次 ≥N 天保底（N 默认 3，admin「设备配置」键 local_audio.refresh_days 可调）/ 熟悉度档位切换 / 任一特质偏移 ≥0.05。
 * 体积预检（2026-09-03）：按近期条目池估算整套体积，预计超 revision 上限就不合成（此前每天白合成 ~165 条 TTS 后在发布门弃置）。
 * 门序：清洗 → 字数门 → 禁词门 → 危机过滤 → （复用判定）→ TTS → 时长门。
 * 发布门（整套原子的服务端镜像）：六 slot 各 ≥MIN_ITEMS_PER_SLOT 条才 commit；
 * 凑不齐 → 不动现套、不前移生成基准（TTS 修复后次日批自动恢复）。
 */

// G1 奖励线共用禁忌（合同 v133 §2「不使用惩罚、排名或焦虑表达」的机械化，含催促/比较/数落）。
// 注意：必须定义在 SLOT_SPECS 之前（const TDZ，模块加载即求值）。
const G1_FORBIDDEN_RE =
  /排名|排行|第[一1]名|比别人|别人|落后|输|惩罚|罚|扣|没收|批评|警告|再不|快点|快些|抓紧|赶紧|来不及|怎么才|才完成|就这么|催/;

// ── slot 规格（时长上限 = codex 回执 §4.3；字数上限按讯飞 x6 实测语速余量预估，探针通后校准）──
export const SLOT_SPECS: Record<
  LocalAudioSlot,
  {
    maxDurationMs: number;
    maxChars: number;
    /** 字数下限（缺省 2）。G1 线用（合同建议 8–20 字为软口径，与 2200ms 硬门取 6–9） */
    minChars?: number;
    scene: string;
    /** 必含语义（v107 姿态健康红线：人格只能改语气，不能丢动作含义）——每个正则都必须命中 */
    requiredRes?: RegExp[];
    /** slot 专属禁忌（叠加在全局 FORBIDDEN_RE 之上） */
    forbiddenRe?: RegExp;
  }
> = {
  'greeting.normal': {
    maxDurationMs: 3000,
    maxChars: 12,
    scene: '孩子喊小可的名字把设备唤醒了，小可答应一声打个招呼（马上要开始聊天，别问问题连环轰炸）',
  },
  'greeting.cover_open': {
    maxDurationMs: 2400,
    maxChars: 9,
    scene: '孩子刚打开台灯的盖子，小可欢迎孩子来到书桌前（很短的一声欢迎）',
  },
  'greeting.presence_return': {
    maxDurationMs: 2400,
    maxChars: 9,
    scene: '孩子离开了一阵子又回到书桌前，小可自然地打个招呼（不提离开多久，不表达等待）',
  },
  'farewell.general': {
    maxDurationMs: 2800,
    maxChars: 10,
    scene: '这次聊天自然结束了，小可轻松地收个尾',
  },
  'farewell.goodbye': {
    maxDurationMs: 2800,
    maxChars: 10,
    scene: '孩子明确说了再见/拜拜，小可开心地道别',
  },
  'farewell.night': {
    maxDurationMs: 2800,
    maxChars: 10,
    scene: '晚上孩子说晚安要去睡觉了，小可安静温柔地说晚安（语气要轻，不兴奋）',
  },
  // ── v107 姿态提醒（optional slot，合同 CODEX_..._POSTURE_V107_JOINT §1/§4）──
  // 健康语义红线：人格可以改变语气/称呼/亲和力，但不能改变动作含义——
  // 必含动作要求（requiredRes 机械门），禁责备/恐吓/医疗式描述/评价外貌（forbiddenRe）。
  'posture.adjust': {
    maxDurationMs: 3200,
    maxChars: 12,
    scene:
      '孩子坐姿偏离已经持续了一会儿，小可提醒孩子调整坐姿。必须明确说出让孩子「调整坐姿/坐直/坐正」这类动作要求（语气可以温和俏皮，但不能只卖萌不说动作）。禁止责备、吓唬、提身体毛病、评价孩子外貌',
    requiredRes: [/调整|坐好|坐直|坐正|挺直|摆正|直起/],
    forbiddenRe: /驼背|脊椎|脊柱|近视|变形|怎么又|说了多少|再不.{0,4}就|警告|罚|笨|丑|难看|不听话|生气/,
  },
  'posture.no_face': {
    maxDurationMs: 3200,
    maxChars: 12,
    scene:
      '设备没有识别清楚孩子在哪里，小可引导孩子回到设备前方能被看到的范围。必须同时说出「看不清/找不到你」和「回来/靠近/坐回来」两层意思（语气自然，像找朋友，不是设备报错）。禁止责备',
    requiredRes: [/看不清|没看清|看不到|找不到|不见你|瞅不见/, /回到|回来|靠近|过来|往前|向前|正对|坐回|挪|移/],
    forbiddenRe: /驼背|脊椎|脊柱|近视|变形|怎么又|说了多少|再不.{0,4}就|警告|罚|笨|丑|难看|不听话|生气/,
  },
  // ── v133 G1 奖励线（optional slot，合同 CODEX_CC_P003_G1_LOCAL_AUDIO_V133_JOINT_20260828 §2/§3）──
  // 语义红线：正向、短、自然；禁惩罚/排名/焦虑/催促（G1_FORBIDDEN_RE 机械门）；
  // requiredRes 保 slot 区分度（coin/chest 必点名对象，final 必带「一整天完成」分量）。
  // 时长硬门 2200ms（合同终值表）与「建议 8–20 字」在讯飞现网语速（约 260ms/字）下互斥，
  // 取 6–9 字执行（8–20 为建议值非硬门；实测 8字=2000ms/9字五五开/10字≥2400ms 必死，且 *_claimed 槽合同意图即「简短确认」，6–7 字更贴）——J1 回执已披露此口径。
  'g1.progress.coin_earned': {
    maxDurationMs: 2200,
    minChars: 6,
    maxChars: 9,
    scene:
      '孩子刚专注完成了一段学习，屏幕上出现了金币奖励等着领。小可肯定这段专注，提一句金币到了。必须提到「金币」。只报喜不催促，不解释规则',
    requiredRes: [/金币/],
    forbiddenRe: G1_FORBIDDEN_RE,
  },
  'g1.progress.chest_earned': {
    maxDurationMs: 2200,
    minChars: 6,
    maxChars: 9,
    scene:
      '孩子攒满了进度，宝箱可以开啦。小可提示宝箱已经准备好，逗孩子去点开看看。必须提到「宝箱」。只提示不啰嗦',
    requiredRes: [/宝箱/],
    forbiddenRe: G1_FORBIDDEN_RE,
  },
  'g1.progress.final_earned': {
    maxDurationMs: 2200,
    minChars: 6,
    maxChars: 9,
    scene:
      '孩子完成了今天全部的学习目标，最后的终极大奖可以领了。小可为孩子完成一整天的目标感到骄傲。要体现「今天全部完成」的成就感。不用跟灯、亮有关的字眼',
    requiredRes: [/今天|一天|全天|全部|终极|最终|大奖/],
    forbiddenRe: G1_FORBIDDEN_RE,
  },
  'g1.reward.coin_claimed': {
    maxDurationMs: 2200,
    minChars: 6,
    maxChars: 9,
    scene: '孩子刚点击领取了金币，领取已经成功。小可开心地确认金币到手，顺口夸孩子一句。必须提到「金币」，不解释规则',
    requiredRes: [/金币/],
    forbiddenRe: G1_FORBIDDEN_RE,
  },
  'g1.reward.chest_claimed': {
    maxDurationMs: 2200,
    minChars: 6,
    maxChars: 9,
    scene: '孩子刚打开了宝箱，画面正在展示宝箱里的奖励。小可跟着开心庆祝一下，衔接画面就好。必须提到「宝箱」',
    requiredRes: [/宝箱/],
    forbiddenRe: G1_FORBIDDEN_RE,
  },
  'g1.reward.final_claimed': {
    maxDurationMs: 2200,
    minChars: 6,
    maxChars: 9,
    scene:
      '孩子领取了今天的终极大奖，这是一天里最高的奖励时刻。小可给出有仪式感的正反馈，为孩子今天的坚持喝彩。要体现「一整天完成」的分量',
    requiredRes: [/今天|一天|全天|全部|终极|最终|大奖|通关/],
    forbiddenRe: G1_FORBIDDEN_RE,
  },
};

const CANDIDATES_PER_CALL = 6; // 每 slot 一次 LLM 要 6 条，过门后取前 5
export const MAX_ITEMS_PER_SLOT = 5; // 导出供容量算术锚（file 限频默认值 ≥ slot数×本值×1.5）
/** 发布预算（codex 2026-09-03 5MiB 裁定 §3）：每槽 2 条 × 14 槽 × 单文件上限 160KiB = 4.375MiB，硬证明在 5MiB 合同门内。
 *  上限不能 server 单边提（Android v193 parser 5MiB 硬门 + 12MiB current/previous 双 revision 预算）。
 *  后续加条走「每槽轮流 +1、加入前按 unique id 算 bytes」，禁止单槽独占余量。 */
export const PUBLISH_ITEMS_PER_SLOT = 2;
const TRAIT_SHIFT_THRESHOLD = 0.05;
/** 保底换新默认天数（admin 设备配置键 local_audio.refresh_days 覆盖；导出供单测锚） */
export const DEFAULT_ROUTINE_REFRESH_DAYS = 3;
/** revision 总量上限（WAV 合同增量 §2.2）。⚠️ 单一真源：发布门与体积预检共用；codex 裁定提额只改这一处。 */
export const REVISION_CAP_BYTES = 5 * 1024 * 1024;

// ── 儿童情绪红线禁词（合同 §5.1：内疚诱导/情绪索取，命中即拒）──
const FORBIDDEN_RE =
  /好想你|想死你|等你好久|等了你|一直在等|你怎么才来|你终于来了|就我一个人|没有你我|你是不是不要|别不理我|想我了|离开我|冷落|寂寞|孤单|没人陪/;

// ── 设备命令词/急停退出词禁入（2026-08-27 回声防线源头层）──
// 背景：真机实证设备本地播的招呼语会被自己的麦克风回收进 ASR（「来啦来啦，刚打了个盹儿」
// 回声混进用户指令句），而 worker 的文本对撞门结构性覆盖不到本地音（不知道端侧播了什么）。
// Matcher 是完整命中制（整句==别名才触发），风险=回声掉字后恰好切出完整别名（如「关灯」二字）
// →防御=文案不得【包含】任一命令别名全串：播出的话里根本没有能被回声利用的词。
// 真值源=64.90 device_aliases.tsv（254 词，快照 assets/device-command-words.tsv，每日批
// 生成前经 hotword 通道自动刷新，拉不到用旧快照——词表低频变更，stale 可接受）。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { callHotwordChannel } from './hotword-channel.js';

const DEVICE_WORDS_SNAPSHOT = resolvePath(process.cwd(), 'assets/device-command-words.tsv');
let deviceWordsCache: string[] | null = null;

function parseDeviceWordsTsv(tsv: string): string[] {
  const words = new Set<string>();
  for (const line of tsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[2].trim()) words.add(parts[2].trim());
    if (parts.length >= 4) for (const a of parts[3].split(',')) if (a.trim()) words.add(a.trim());
  }
  // 长词优先无关紧要（contains 判定），但排序让日志/调试稳定
  return [...words].sort();
}

function deviceCommandWords(): string[] {
  if (deviceWordsCache) return deviceWordsCache;
  try {
    deviceWordsCache = parseDeviceWordsTsv(readFileSync(DEVICE_WORDS_SNAPSHOT, 'utf-8'));
  } catch {
    // 快照缺失的兜底核心集（显眼日志——快照才是真值，兜底只保命）
    console.log('[local-audio] ⚠️ 设备命令词快照缺失，用内置兜底核心集');
    deviceWordsCache = ['开灯', '关灯', '静音', '大声', '小声', '调亮', '调暗', '调远', '调近', '暖光', '冷光'];
  }
  return deviceWordsCache;
}

/** 每日批生成前刷新词表快照（与 64.90 tsv 真值同源；失败用旧快照，不阻断生成）。 */
export async function refreshDeviceCommandWords(): Promise<void> {
  try {
    const r = await callHotwordChannel({ action: 'device_aliases' }, 15_000);
    if (r.ok && typeof r.tsv === 'string' && r.tsv.includes('\t')) {
      writeFileSync(DEVICE_WORDS_SNAPSHOT, r.tsv);
      deviceWordsCache = parseDeviceWordsTsv(r.tsv);
      console.log(`[local-audio] 设备命令词快照已刷新（${deviceWordsCache.length} 词）`);
    }
  } catch {
    console.log('[local-audio] 设备命令词快照刷新失败，用现有快照');
  }
}

// 急停/退出词（真值源=64.90 rust-worker.env 的 INTERRUPT_HOTWORDS/EXIT_SWALLOW_HOTWORDS，
// 低频稳定故静态内置；改 env 词表时同步此处）。EXIT 词对 farewell 三 slot 豁免——道别文案
// 必须能说「再见/拜拜」，且告别音播放时会话已结束、回声无处可去。
const STOP_WORDS = ['停', '等等', '等一下']; // 裸「停」contains 已覆盖停止/停下/停一下——宁严，拒了重出即可
const EXIT_WORDS = [
  '不想聊了', '不聊了', '先不聊了', '不用了', '退出', '结束对话', '结束聊天', '再见', '拜拜',
  '回见', '下次见', '下次再聊', '先这样', '就到这里', '到此为止',
];

/** 导出供 filler-generator 复用（filler 无 farewell 语义，allowExitWords 恒 false）。 */
export function commandEchoReason(text: string, opts?: { allowExitWords?: boolean }): string | null {
  for (const w of deviceCommandWords()) if (text.includes(w)) return `device_command_word:${w}`;
  for (const w of STOP_WORDS) if (text.includes(w)) return `stop_word:${w}`;
  if (!opts?.allowExitWords) {
    for (const w of EXIT_WORDS) if (text.includes(w)) return `exit_word:${w}`;
  }
  return null;
}

/** 清洗：去代码块、括号舞台指示、emoji、控制符、首尾引号与多空白。 */
export function sanitizeClipText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[\x00-\x1f\x7f<>]/g, '')
    .replace(/^["'「『\s]+|["'」』\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 计字：中文/字母/数字计入，标点空白不计（合同 §4 字数口径）。 */
export function countChars(text: string): number {
  return (text.match(/[㐀-䶿一-鿿豈-﫿A-Za-z0-9]/g) ?? []).length;
}

export type GateResult = { ok: true; text: string } | { ok: false; reason: string };

/** 文案门（TTS 之前的全部门，导出供单测+负锚验收 A1）。 */
export function gateClipText(raw: string, slot: LocalAudioSlot): GateResult {
  const text = sanitizeClipText(raw);
  const chars = countChars(text);
  const spec = SLOT_SPECS[slot];
  if (chars < (spec.minChars ?? 2)) return { ok: false, reason: 'too_short' };
  if (chars > spec.maxChars) return { ok: false, reason: `too_long:${chars}` };
  if (FORBIDDEN_RE.test(text)) return { ok: false, reason: 'forbidden_phrase' };
  // 回声防线源头层：文案不得含设备命令别名/急停退出词（详见 commandEchoReason 处注释）
  const echoRisk = commandEchoReason(text, { allowExitWords: slot.startsWith('farewell.') });
  if (echoRisk) return { ok: false, reason: echoRisk };
  if (spec.forbiddenRe?.test(text)) return { ok: false, reason: 'slot_forbidden' };
  // 必含语义（姿态健康红线）：每个 requiredRes 正则都要命中——动作含义不许被人格化掉
  for (const re of spec.requiredRes ?? []) {
    if (!re.test(text)) return { ok: false, reason: 'missing_action' };
  }
  if (isCrisisContent(text)) return { ok: false, reason: 'crisis_content' };
  return { ok: true, text };
}

/** 特质快照 → prompt 里的性格描述行（只描述小可自己，绝不含孩子字段，合同 §5.3）。
 *  baseline 可传家长风格模板的 per-account 基线（P2 2026-09-01）；缺省=出厂，向后兼容。 */
export function traitPromptLines(traits: Record<TraitDim, number>, baseline?: Record<TraitDim, number>): string[] {
  return TRAIT_DIMS.map((dim) => {
    const v = traits[dim];
    const base = (baseline ?? TRAIT_BASELINE)[dim];
    const diff = v - base;
    const trend = diff >= 0.05 ? '（最近偏高）' : diff <= -0.05 ? '（最近偏低）' : '';
    return `- ${TRAIT_LABELS[dim]}：${v.toFixed(2)}，人设基线 ${base.toFixed(2)}${trend}`;
  });
}

export type RegenTrigger =
  | { kind: 'first_time' }
  | { kind: 'routine'; days: number }
  | { kind: 'tier_change'; from: string; to: string }
  | { kind: 'trait_shift'; dim: TraitDim; delta: number }
  | { kind: 'manual' };

export function describeTrigger(t: RegenTrigger): string {
  switch (t.kind) {
    case 'first_time':
      return '首次生成';
    case 'routine':
      return `${t.days} 天保底换新`;
    case 'tier_change':
      return `熟悉度档位变化：${t.from || '—'}→${t.to}`;
    case 'trait_shift':
      return `特质偏移：${TRAIT_LABELS[t.dim]} Δ${t.delta >= 0 ? '+' : ''}${t.delta.toFixed(2)}`;
    case 'manual':
      return '手动触发';
  }
}

function triggerTheory(t: RegenTrigger): 'attachment' | 'state_to_trait' {
  return t.kind === 'tier_change' ? 'attachment' : 'state_to_trait';
}

/** 触发判断（导出供单测）。tierNow 需外部算好传入（依赖 relation state）。 */
export function shouldRegenerate(
  state: { last_generated_at: number; gen_tier: string; gen_traits: string },
  tierNow: string,
  traitsNow: Record<TraitDim, number>,
  now = Date.now(),
  routineDays = DEFAULT_ROUTINE_REFRESH_DAYS,
): RegenTrigger | null {
  if (!state.last_generated_at) return { kind: 'first_time' };
  if (state.gen_tier && state.gen_tier !== tierNow) return { kind: 'tier_change', from: state.gen_tier, to: tierNow };
  try {
    const prev = JSON.parse(state.gen_traits || '{}') as Partial<Record<TraitDim, number>>;
    for (const dim of TRAIT_DIMS) {
      const before = prev[dim];
      if (typeof before !== 'number') continue;
      const delta = traitsNow[dim] - before;
      if (Math.abs(delta) >= TRAIT_SHIFT_THRESHOLD) return { kind: 'trait_shift', dim, delta };
    }
  } catch {
    /* gen_traits 解析失败按无基准处理 */
  }
  if (now - state.last_generated_at >= routineDays * 86_400_000) return { kind: 'routine', days: routineDays };
  return null;
}

/** 保底换新天数：admin 设备配置（SN 覆盖 > 全局 > 内置 3）。accountId 形如 device-<SN>。 */
export function routineRefreshDays(accountId: string): number {
  const sn = accountId.startsWith('device-') ? accountId.slice('device-'.length) : accountId;
  return configStore.getEffective(sn, 'local_audio.refresh_days');
}

/**
 * 体积预检（纯函数，导出供单测）：每槽取最新 ≤ perSlotMax 条的字节数求和 = 下轮整套的估计体积。
 * 池 = 该账号近期 wav 条目（active + staging），正是发布门会保留的材料；估高于估低——宁可多拦一轮，也不再白合成。
 */
export function estimateRevisionBytes(poolBySlot: Record<string, number[]>, perSlotMax = MAX_ITEMS_PER_SLOT): number {
  let total = 0;
  for (const sizes of Object.values(poolBySlot)) {
    for (const b of sizes.slice(0, perSlotMax)) total += b;
  }
  return total;
}

function sizePrecheck(accountId: string): { est: number; over: boolean } {
  const pool: Record<string, number[]> = {};
  for (const slot of LOCAL_AUDIO_SLOTS) pool[slot] = localAudioStore.listRecentBytesBySlot(accountId, slot, PUBLISH_ITEMS_PER_SLOT);
  // 设备回复槽（已 active 的 18 条）随套搬运，体积一并计入
  const est = estimateRevisionBytes(pool, PUBLISH_ITEMS_PER_SLOT) + activeDeviceReplyKeep(accountId).reduce((a, k) => a + k.bytes, 0);
  return { est, over: est > REVISION_CAP_BYTES };
}

/** 人格快照 system prompt（单一真源）——导出供 filler-generator 复用（F1 2026-08-26）。 */
export function buildSystemPrompt(accountId: string): string {
  const rel = relationStateStore.getState(accountId);
  const traits = traitStore.get(accountId);
  const narrative = relationStateStore.getNarrative(accountId);
  const daysKnown = rel ? Math.max(0, Math.floor((Date.now() - rel.first_seen_at) / 86_400_000)) : 0;
  const tier = rel ? familiarityTier(rel.session_count, daysKnown) : '新朋友';

  // P2 风格档联动（2026-09-01）：基线对照锚定家长模板；styleRule 并入性格快照——
  // 招呼语/告别语/filler（本函数是单一真源，filler-generator 复用）随风格档走。
  const styleTpl = getStyleTemplate(traitStore.getTemplate(accountId));
  const lines = [
    '你是儿童陪伴 AI「小可」的台词创作助手。小可是台灯上的 AI 伙伴，陪 6-10 岁的孩子聊天学习。',
    '下面是小可当前的性格快照（会随着和孩子相处慢慢变化，文案要体现这个性格）：',
    ...traitPromptLines(traits, traitStore.baselineFor(accountId)),
    `- 和孩子的关系：${tier}${rel ? `（认识 ${daysKnown} 天，聊过 ${rel.session_count} 次）` : ''}`,
  ];
  if (styleTpl) lines.push(`- ${styleTpl.styleRule}（这是家长为小可设定的说话风格，文案的语气节奏要体现它）`);
  if (narrative?.text) lines.push(`- 小可心里的小笔记：「${narrative.text.slice(0, 60)}」（只用来体会语气，内容绝不照搬进文案）`);
  lines.push(
    '',
    '硬约束（违反任何一条整条作废）：',
    '1. 绝不出现孩子的名字、昵称或任何称呼个体的词；不提任何具体经历或约定。',
    '2. 绝不出现让孩子内疚的表达：想你、等你、你怎么才来、就我一个人、寂寞孤单之类全部禁止。',
    '3. 口语化、自然、像同龄玩伴；不许书面语，不许「亲爱的」「宝贝」。',
    '4. 每条都要不一样，风格有变化；不用感叹号堆砌。',
    '只输出 JSON 字符串数组，不要任何其他内容。',
  );
  return lines.join('\n');
}

async function generateSlotCandidates(accountId: string, slot: LocalAudioSlot, promptSuffix?: string): Promise<string[]> {
  const spec = SLOT_SPECS[slot];
  const raw = await callExtractionLlm(
    buildSystemPrompt(accountId),
    `场景：${spec.scene}\n请写恰好 ${CANDIDATES_PER_CALL} 条候选，每条${spec.minChars ? `严格 ${spec.minChars} 到 ${spec.maxChars} 个字——写完逐条数一遍字数，不足或超出的换一条再写` : `不超过 ${spec.maxChars} 个字`}（标点不计但尽量少用标点）。\n输出格式示例（纯字符串数组）：["文案一","文案二","文案三"]${promptSuffix ? `\n补充要求：${promptSuffix}` : ''}`,
    { maxTokens: 500, timeoutMs: 30000 },
  );
  if (!raw) {
    console.log(`[local-audio] llm empty slot=${slot}`);
    return [];
  }
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    console.log(`[local-audio] llm no-array slot=${slot} raw=${JSON.stringify(raw.slice(0, 120))}`);
    return [];
  }
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is string => typeof s === 'string');
  } catch {
    // 容错：LLM 偶发输出 [{"文案"}] 伪对象形态（night 场景实测稳定复现）——
    // 把数组文本里的字符串字面量直接抠出来当候选，下游门会再筛，安全
    const salvaged = [...match[0].matchAll(/"([^"\n]{2,40})"/g)].map((m) => m[1]);
    console.log(
      `[local-audio] llm bad-json slot=${slot} salvaged=${salvaged.length} raw=${JSON.stringify(match[0].slice(0, 120))}`,
    );
    return salvaged;
  }
}

export type SlotBuildResult = {
  slot: LocalAudioSlot;
  keep: Array<{ slot: LocalAudioSlot; id: string; text: string }>;
  newCount: number;
  reusedCount: number;
  rejected: Record<string, number>;
  keptOld: boolean; // 新候选不足，沿用旧 active 条目
};

/** 单 slot 构建：候选 → 门 → 复用/合成 → 时长门。不落 active 状态（由 commit 统一）。
 *  导出供外科式发布脚本用（如 v107 姿态扩展：只生成姿态 slot、六必选 slot 原 ID 保持）。 */
export async function buildSlot(
  accountId: string,
  slot: LocalAudioSlot,
  promptSuffix?: string,
  target = PUBLISH_ITEMS_PER_SLOT,
  reuseStagingFirst = false,
): Promise<SlotBuildResult> {
  const spec = SLOT_SPECS[slot];
  // WAV 迁移铁律：复用/补足/兜底全链只认 wav 条目（MP3 存量只作下载存量与回滚锚，绝不回流进新套）
  const oldActive = localAudioStore.listActive(accountId).filter((i) => i.slot === slot && i.format === 'wav');
  const rejected: Record<string, number> = {};
  const keep: Array<{ slot: LocalAudioSlot; id: string; text: string }> = [];
  const seenTexts = new Set<string>();

  // codex 2026-09-03 §3.3.2：灰度发布优先复用 staging 里已过全部门（文案/WAV/SHA/时长/160KiB）的条目，够 target 就不叫 LLM/TTS
  if (reuseStagingFirst) {
    for (const st of localAudioStore.listStagedBySlot(accountId, slot)) {
      if (keep.length >= target) break;
      if (seenTexts.has(st.text)) continue;
      seenTexts.add(st.text);
      keep.push({ slot, id: st.id, text: st.text });
    }
    if (keep.length >= target) {
      console.log(`[local-audio] gen slot=${slot} staging 优先复用 ${keep.length} 条，跳过 LLM/TTS`);
      return { slot, keep, newCount: keep.length, reusedCount: 0, rejected, keptOld: false };
    }
  }

  const candidates = await generateSlotCandidates(accountId, slot, promptSuffix);
  for (const raw of candidates) {
    if (keep.length >= target) break;
    const gated = gateClipText(raw, slot);
    if (!gated.ok) {
      rejected[gated.reason] = (rejected[gated.reason] ?? 0) + 1;
      continue;
    }
    if (seenTexts.has(gated.text)) continue;
    seenTexts.add(gated.text);

    // J4 复用：同 slot 同 text 直接复活旧条目，不重合成（TTS 非确定性，重合成=白换 id）
    const existing = localAudioStore.findByText(accountId, slot, gated.text);
    if (existing) {
      keep.push({ slot, id: existing.id, text: existing.text });
      continue;
    }

    // WAV 合同增量：讯飞 raw PCM 直出 + server 拼 RIFF 头（零转码零 ffmpeg，比 MP3 中转少一代有损）
    const tts = await synthesizeXfyunTtsWav(gated.text);
    if (!tts) {
      rejected.tts_failed = (rejected.tts_failed ?? 0) + 1;
      continue;
    }
    if (tts.durationMs > spec.maxDurationMs) {
      rejected[`too_long_audio:${tts.durationMs}ms`] = (rejected[`too_long_audio:${tts.durationMs}ms`] ?? 0) + 1;
      continue;
    }
    if (tts.audio.length > 160 * 1024) { // 单文件门 160KiB（WAV 合同增量 §2.2）
      rejected.file_too_big = (rejected.file_too_big ?? 0) + 1;
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(tts.audio).digest('hex');
    const id = sha256.slice(0, 16);
    localAudioStore.writeAudio(accountId, id, tts.audio, 'wav');
    localAudioStore.insertItem(accountId, {
      slot,
      id,
      text: gated.text,
      sha256,
      bytes: tts.audio.length,
      duration_ms: tts.durationMs,
      format: 'wav',
    });
    keep.push({ slot, id, text: gated.text });
  }

  // 不足保底先从 staging 补（往轮已合成、发布 abort 留下的 active=0 条目）——
  // LLM 偶发空返回/格式劣化时，已过全部门+已花 TTS 的存量不白扔，整轮不至于被单 slot 拖死
  if (keep.length < MIN_ITEMS_PER_SLOT) {
    const staged = localAudioStore
      .listStagedBySlot(accountId, slot)
      .filter((s) => !keep.some((k) => k.id === s.id) && !seenTexts.has(s.text));
    for (const s of staged) {
      if (keep.length >= target) break;
      keep.push({ slot, id: s.id, text: s.text });
      seenTexts.add(s.text);
    }
    if (staged.length) console.log(`[local-audio] gen slot=${slot} staging 补足 +${Math.min(staged.length, keep.length)}`);
  }

  const reusedCount = keep.filter((k) => oldActive.some((o) => o.id === k.id)).length;
  const newCount = keep.length - reusedCount;

  // 仍不够保底 → 该 slot 沿用旧 active 条目（合同 §4：保持上一版不切换）
  if (keep.length < MIN_ITEMS_PER_SLOT && oldActive.length >= MIN_ITEMS_PER_SLOT) {
    return {
      slot,
      keep: oldActive.slice(0, target).map((i) => ({ slot, id: i.id, text: i.text })),
      newCount: 0,
      reusedCount: Math.min(oldActive.length, target),
      rejected,
      keptOld: true,
    };
  }
  return { slot, keep, newCount, reusedCount, rejected, keptOld: false };
}

/**
 * 单账号生成主入口。opts.force 跳过触发判断（admin 手动触发）。
 * 返回：{ok, trigger?, revision?, detail} —— probe/回执可读。
 */
/**
 * 绑定即生成的门（2026-09-06 川哥拍板；0001 首日实证：白天建档要等次日沪时 3 点每日批才有成长语音，第 0 天只有 APK 内置）：
 * 开关开 + 从未生成过（revision 0 且 last_generated_at 0）才在开通 brain 时异步触发一次。重复开通 / 换绑到旧账号不重生成；
 * 真正生成仍走 runLocalAudioForAccount 的 first_time 触发（尊重 LOCAL_AUDIO_GENERATION_PAUSED 与体积预检）。
 */
export function shouldKickoffLocalAudioOnOpen(
  state: { revision: number; last_generated_at: number },
  enabled: boolean,
): boolean {
  return enabled && state.revision === 0 && state.last_generated_at === 0;
}

/** 绑定即生成的并发去重：同账号在途生成只允许一个（announce 重试 / claim 幂等恢复 / 重复开通不得反复建档生成）。 */
const kickoffInFlight = new Set<string>();

/**
 * 绑定即生成的唯一入口（开通 brain / performSnBinding 共用）：开关 + 从未生成 + 不在途 三门后异步起一次，
 * 不阻塞调用方、失败只留日志；生成本身仍受 runLocalAudioForAccount 的暂停开关 / 体积预检 / 发布门约束。
 */
export function kickoffLocalAudioOnce(
  accountId: string,
  reason: string,
): 'started' | 'skipped_disabled' | 'skipped_generated' | 'skipped_in_flight' {
  if (!personaLocalAudioEnabled(accountId)) return 'skipped_disabled';
  if (!shouldKickoffLocalAudioOnOpen(localAudioStore.getState(accountId), true)) return 'skipped_generated';
  if (kickoffInFlight.has(accountId)) return 'skipped_in_flight';
  kickoffInFlight.add(accountId);
  console.log(`[local-audio] kickoff account=${accountId} reason=${reason}`);
  void runLocalAudioForAccount(accountId)
    .then((r) => console.log(`[local-audio] kickoff done account=${accountId} ${JSON.stringify(r)}`))
    .catch((err) => console.log(`[local-audio] kickoff failed account=${accountId}: ${String((err as Error)?.message ?? err)}`))
    .finally(() => kickoffInFlight.delete(accountId));
  return 'started';
}

export async function runLocalAudioForAccount(
  accountId: string,
  opts?: { force?: boolean; reuseStagingFirst?: boolean },
): Promise<{ ok: boolean; skipped?: string; trigger?: string; revision?: number | null; detail?: string }> {
  try {
    const rel = relationStateStore.getState(accountId);
    const traits = traitStore.get(accountId);
    const daysKnown = rel ? Math.max(0, Math.floor((Date.now() - rel.first_seen_at) / 86_400_000)) : 0;
    const tierNow = rel ? familiarityTier(rel.session_count, daysKnown) : '新朋友';
    const state = localAudioStore.getState(accountId);

    // WAV 迁移窗口闸（codex WAV 增量 W3 前）：挡每日批自动生成，admin force 手动不受限
    if (!opts?.force && process.env.LOCAL_AUDIO_GENERATION_PAUSED === '1') {
      return { ok: true, skipped: 'generation_paused' };
    }
    // 生成前刷新设备命令词快照（与 64.90 tsv 真值同源；失败用旧快照不阻断）
    await refreshDeviceCommandWords();
    const trigger: RegenTrigger | null = opts?.force
      ? { kind: 'manual' }
      : shouldRegenerate(state, tierNow, traits, Date.now(), routineRefreshDays(accountId));
    if (!trigger) return { ok: true, skipped: 'no_trigger' };
    const triggerText = describeTrigger(trigger);
    // 体积预检：预计整套超上限就不进合成（admin force 手动不受限——人在看结果）
    if (!opts?.force) {
      const pre = sizePrecheck(accountId);
      if (pre.over) {
        console.log(
          `[local-audio] gen skip account=${accountId} trigger=${triggerText} 体积预检 est=${pre.est}B > ${REVISION_CAP_BYTES}B（按近期条目池估算，不重合成；等上限裁定或裁剪）`,
        );
        return { ok: true, skipped: 'size_precheck', trigger: triggerText, detail: `est=${pre.est}` };
      }
    }
    console.log(`[local-audio] gen start account=${accountId} trigger=${triggerText}`);

    const oldActive = localAudioStore.listActive(accountId);
    const results: SlotBuildResult[] = [];
    for (const slot of LOCAL_AUDIO_SLOTS) {
      const r = await buildSlot(accountId, slot, undefined, PUBLISH_ITEMS_PER_SLOT, opts?.reuseStagingFirst === true);
      results.push(r);
      const rej = Object.entries(r.rejected)
        .map(([k, v]) => `${k}x${v}`)
        .join(',');
      console.log(
        `[local-audio] gen slot=${r.slot} new=${r.newCount} reused=${r.reusedCount} keptOld=${r.keptOld}${rej ? ` rejected=${rej}` : ''}`,
      );
    }

    // 发布门（v107）：六 required slot 各 ≥ 保底才 commit（整套原子；否则不动现套、不前移基准，次日批重试）。
    // posture.* 为 optional：缺失合法（端侧回退 APK 内置），但 1 条不成套——弃置（条目留 staging 下轮补足再进）
    for (const r of results) {
      if (!REQUIRED_SLOTS.includes(r.slot) && r.keep.length === 1) {
        console.log(`[local-audio] gen slot=${r.slot} optional 单条不成套，本轮弃置（条目留 staging）`);
        r.keep = [];
      }
    }
    const short = results.filter((r) => REQUIRED_SLOTS.includes(r.slot) && r.keep.length < MIN_ITEMS_PER_SLOT);
    if (short.length > 0) {
      console.log(
        `[local-audio] gen abort account=${accountId} 未达发布门: ${short.map((r) => `${r.slot}=${r.keep.length}`).join(' ')}（现套与生成基准均不动）`,
      );
      return { ok: false, trigger: triggerText, detail: `slots_short:${short.map((r) => r.slot).join(',')}` };
    }

    // 设备回复槽（合同 v3.1 §5）：只搬运**已 active** 的条目——staging 里的十八条绝不在这里自动提为 active，
    // 发布必须显式走 scripts/local-audio-device-reply.ts --publish（新的不可变 revision）
    const deviceReplyKeep = activeDeviceReplyKeep(accountId);
    // revision 总量门 ≤5MiB（WAV 合同增量 §2.2）：超限不发布（超大套宁可保持旧套）
    // 合同 §3.3.4：按去重后的 clip id 计总量（同一条目跨槽复用只算一次，与 manifest 一致）
    const seenIds = new Set<string>();
    const totalBytes = [...results.flatMap((r) => r.keep), ...deviceReplyKeep.map((k) => ({ slot: k.slot, id: k.id }))]
      .reduce((sum, k) => {
        if (seenIds.has(k.id)) return sum;
        seenIds.add(k.id);
        return sum + (localAudioStore.getItem(accountId, k.id)?.bytes ?? 0);
      }, 0);
    if (totalBytes > REVISION_CAP_BYTES) {
      console.log(`[local-audio] gen abort account=${accountId} revision 总量超限 ${totalBytes}B > ${REVISION_CAP_BYTES}B`);
      return { ok: false, trigger: triggerText, detail: `revision_too_big:${totalBytes}` };
    }

    const keepAll = [...results.flatMap((r) => r.keep.map(({ slot, id }) => ({ slot, id }))), ...deviceReplyKeep.map(({ slot, id }) => ({ slot, id }))];
    const revision = localAudioStore.commitSet(accountId, keepAll, {
      tier: tierNow,
      traits: JSON.stringify(traits),
    });

    if (revision !== null) {
      // 成长账本：每个内容变化的 slot 记一条（因果白盒，合同 §6）
      for (const r of results) {
        const oldTexts = oldActive.filter((i) => i.slot === r.slot).map((i) => i.text);
        const newTexts = r.keep.map((k) => k.text);
        if (JSON.stringify([...oldTexts].sort()) === JSON.stringify([...newTexts].sort())) continue;
        growthLedgerStore.record(accountId, {
          module: 'local_audio',
          dimension: r.slot,
          from: oldTexts.length ? oldTexts.slice(0, 2).join(' / ') : '—',
          to: newTexts.slice(0, 2).join(' / '),
          rule: `local_audio:${trigger.kind}`,
          theory: triggerTheory(trigger),
          note: `${triggerText} → 换了新说法（${newTexts.length} 条，新增 ${r.newCount}）`,
        });
      }
      console.log(`[local-audio] gen commit account=${accountId} revision=${revision} trigger=${triggerText}`);
    } else {
      console.log(`[local-audio] gen no-change account=${accountId}（内容未变不 bump）`);
    }
    const cleaned = localAudioStore.cleanup(accountId);
    if (cleaned) console.log(`[local-audio] cleanup account=${accountId} removed=${cleaned}`);
    return { ok: true, trigger: triggerText, revision };
  } catch (err) {
    console.log(`[local-audio] gen error account=${accountId}:`, String((err as Error)?.message ?? err));
    return { ok: false, detail: String((err as Error)?.message ?? err) };
  }
}
