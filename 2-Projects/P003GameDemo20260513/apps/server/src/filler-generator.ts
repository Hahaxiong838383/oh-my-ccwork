// 衔接短语（filler）人格化生成（F1，2026-08-26 川哥拍板：003+0010 双机灰度，桶=greet/gen/task，
// barge 桶永不人格化——打断承接是功能音，1200ms 硬约束下人格化收益最低、体验风险最高）。
//
// filler 与本地音频（local-audio）的分工：filler 是 worker 侧在线链路的承接音（server 生成→
// 发布到 64.90 per-SN 目录→F2 后 worker 按 SN 加载），不进设备 manifest、不占 local_audio 表。
// 生成规矩全部继承 gen_fillers_v6.py 三代人工迭代沉淀的川哥听感原则（v3/v3.1/v4 注释），
// 从「人工改脚本」升格为「按人格快照生成 + 机械门」。
import crypto from 'node:crypto';
import { buildSystemPrompt, commandEchoReason } from './local-audio-generator.js';
import { callExtractionLlm } from './llm-extract.js';
import { synthesizeXfyunTtsWav, parseWavHeader } from './providers/xfyun-tts.js';
import { isCrisisContent } from './memory-safety-filter.js';

/** F1 灰度桶（其余 7 桶 worker 自动落全局 colleague 套；barge 结构性排除——见文件头）。 */
export const FILLER_BUCKETS = ['greet', 'gen', 'task'] as const;
export type FillerBucket = (typeof FILLER_BUCKETS)[number];

export const FILLER_BUCKET_SPECS: Record<FillerBucket, { scene: string; count: number }> = {
  greet: {
    count: 9,
    scene: '孩子刚打招呼/喊小可，正式回复还没出来，小可先应一声接住（如「哎，你好呀」「来啦」的感觉）',
  },
  gen: {
    count: 9,
    scene: '孩子说了句话，小可需要想一想，先出个自然的思考承接（如「嗯呐，我想想」「哦，这样啊」的感觉）',
  },
  task: {
    count: 9,
    scene: '孩子提了个请求/任务（讲个故事/帮我查查），小可先应下正在准备（如「来，听好了哈」「我看看哈」的感觉）',
  },
};

// 儿童情绪红线（与 local-audio FORBIDDEN_RE 同源语义,filler 场景同样禁内疚诱导/情绪索取）
const FORBIDDEN_RE =
  /好想你|想死你|等你好久|等了你|一直在等|你怎么才来|你终于来了|就我一个人|没有你我|你是不是不要|别不理我|想我了|离开我|冷落|寂寞|孤单|没人陪/;

// filler 四纪律的机械门形态（源自 gen_fillers_v6.py v4 注释=川哥三代听感反馈）：
// ①不用「好/行」应答词开头（显生涩） ②不追问（会和紧跟的正式回复打架） ③书面语/称呼词禁
const ANSWER_WORD_OPEN_RE = /^(好|行)([,，。的呀啦]|$)/;
const FOLLOWUP_RE = /然后呢|接着说|快说|再说说|讲讲看/;
const BOOKISH_RE = /亲爱的|宝贝|您/;

export type FillerGate = { ok: true; text: string } | { ok: false; reason: string };

export function gateFillerText(raw: string): FillerGate {
  const text = raw
    .replace(/[（(][^（()）]*[)）]/g, '')
    .replace(/[\x00-\x1f\x7f<>]/g, '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .trim();
  const chars = [...text].filter((ch) => /[一-龥a-zA-Z0-9]/.test(ch)).length;
  if (chars < 1) return { ok: false, reason: 'too_short' };
  if (chars > 10) return { ok: false, reason: `too_long:${chars}` };
  // 回声防线源头层（同 local-audio 门）：filler 虽在 worker 对撞集内，双保险成本一行
  const echoRisk = commandEchoReason(text);
  if (echoRisk) return { ok: false, reason: echoRisk };
  if (ANSWER_WORD_OPEN_RE.test(text)) return { ok: false, reason: 'answer_word_open' };
  if (FOLLOWUP_RE.test(text)) return { ok: false, reason: 'followup' };
  if (BOOKISH_RE.test(text)) return { ok: false, reason: 'bookish' };
  if (FORBIDDEN_RE.test(text)) return { ok: false, reason: 'forbidden_phrase' };
  if (isCrisisContent(text)) return { ok: false, reason: 'crisis_content' };
  return { ok: true, text };
}

export type FillerClip = {
  fname: string;
  bucket: FillerBucket;
  text: string;
  wav: Buffer;
  duration_ms: number;
  chars: number;
  sha256: string;
};

async function generateBucketCandidates(accountId: string, bucket: FillerBucket): Promise<string[]> {
  const spec = FILLER_BUCKET_SPECS[bucket];
  const raw = await callExtractionLlm(
    buildSystemPrompt(accountId),
    `场景：${spec.scene}\n` +
      `这是「承接音」：孩子说完话到小可正式回复之间零点几秒里播的一声短应答，只做承接不给内容。\n` +
      `写恰好 ${spec.count + 3} 条候选，规矩：\n` +
      `1. 长短参差：约 1/3 超短（1-2 个字，如「唔？」「嗯呐」），其余 3-9 个字——全一样长会显机械。\n` +
      `2. 用语气词承载情绪（哎/哟/嗐/嗯呐/哈/呀），绝不用「好」「行」这类应答词开头。\n` +
      `3. 只承接不给立场、不追问（「然后呢」这类会和马上要说的正式回复打架）。\n` +
      `4. 口语像同龄玩伴，体现上面的性格快照；每条风格要有变化。\n` +
      `输出格式示例（纯字符串数组）：["文案一","文案二"]`,
    { maxTokens: 600, timeoutMs: 30000 },
  );
  if (!raw) return [];
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [...match[0].matchAll(/"([^"\n]{1,20})"/g)].map((m) => m[1]);
  }
}

/** 单桶构建：候选→门→合成→时长门（≤2500ms，v4 口径「>3s 必砍」收紧半秒）。 */
export async function buildFillerBucket(accountId: string, bucket: FillerBucket): Promise<{ clips: FillerClip[]; rejected: Record<string, number> }> {
  const spec = FILLER_BUCKET_SPECS[bucket];
  const rejected: Record<string, number> = {};
  const clips: FillerClip[] = [];
  const seen = new Set<string>();
  const candidates = await generateBucketCandidates(accountId, bucket);
  let idx = 0;
  for (const raw of candidates) {
    if (clips.length >= spec.count) break;
    const gated = gateFillerText(raw);
    if (!gated.ok) {
      rejected[gated.reason] = (rejected[gated.reason] ?? 0) + 1;
      continue;
    }
    if (seen.has(gated.text)) continue;
    seen.add(gated.text);
    const tts = await synthesizeXfyunTtsWav(gated.text);
    if (!tts) {
      rejected.tts_failed = (rejected.tts_failed ?? 0) + 1;
      continue;
    }
    if (tts.durationMs > 2500) {
      rejected[`too_long_audio:${tts.durationMs}ms`] = (rejected[`too_long_audio:${tts.durationMs}ms`] ?? 0) + 1;
      continue;
    }
    const info = parseWavHeader(tts.audio);
    if (!info || info.sampleRate !== 24000 || info.channels !== 1) {
      rejected.bad_wav = (rejected.bad_wav ?? 0) + 1;
      continue;
    }
    idx += 1;
    clips.push({
      fname: `p_${bucket}_${String(idx).padStart(2, '0')}.wav`,
      bucket,
      text: gated.text,
      wav: tts.audio,
      duration_ms: tts.durationMs,
      chars: [...gated.text].filter((ch) => /[一-龥a-zA-Z0-9]/.test(ch)).length,
      sha256: crypto.createHash('sha256').update(tts.audio).digest('hex'),
    });
  }
  return { clips, rejected };
}
