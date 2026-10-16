import { assertLocalAudioWritesAllowed } from './local-audio-integrity.js';
/**
 * G1 设置引导三句（Android codex《G1设置引导正式小可音色_服务端离线语音联调需求》2026-09-17；
 * 川哥 2026-09-17 18:57 拍板 A 方案：音色/语速/音量基线不动，端侧放宽上限；先灰度 …03800006）。
 *
 * 与十八条设备回复同模板：文本冻结、每槽 1 条、optional；不进 LLM 生成循环；stage 只入 staging（active=0），
 * 发布必须显式（scripts/local-audio-g1-settings.ts publish → 新的不可变 revision）；日常再生成只搬运已 active
 * 的条目（activeG1SettingsKeep → generator.carriedFrozenKeep）。
 *
 * 与十八条不同的一点：**合成一次、同一份字节扇出到各账号**（id = sha256 前 16 位 → 同字节同 id），
 * 全机队与 APK 内置兜底逐字节相同（讯飞 TTS 非确定性，按账号各合成会得到不同字节）。
 * 上限（A 方案）：单文件 ≤400 KiB；时长 enter ≤3000 / intro ≤8000 / exit ≤5500 ms。
 * 物理：WAV PCM16/mono/24 kHz 每秒 48 000 B，160 KiB 只装 3.4 s——原需求「≤160 KiB + intro 7 s」互斥，端侧按本上限放宽。
 */
import crypto from 'node:crypto';
import { synthesizeXfyunTtsWav, parseWavHeader } from './providers/xfyun-tts.js';
import { localAudioStore, G1_SETTINGS_SLOTS, type G1SettingsSlot } from './local-audio-store.js';

/** 冻结文本（Android codex 需求 §1 逐字；含标点，WAV 可听内容必须与之一致） */
export const G1_SETTINGS_TEXTS: Readonly<Record<G1SettingsSlot, string>> = {
  'g1.settings.enter': '向下滑动，进入设置。',
  'g1.settings.intro': '在这里，可以把灯光设置成你喜欢的亮度和色温，调节音量大小，来试试吧。',
  'g1.settings.exit': '学会啦，向上滑动，回到方舟继续使用吧。',
};
export const G1_SETTINGS_MAX_BYTES = 400 * 1024;
export const G1_SETTINGS_MAX_MS: Readonly<Record<G1SettingsSlot, number>> = {
  'g1.settings.enter': 3000,
  'g1.settings.intro': 8000,
  'g1.settings.exit': 5500,
};
export const G1_SETTINGS_WAV = { sampleRate: 24000, channels: 1, bitsPerSample: 16 } as const;

export type G1SettingsOrigin = 'imported' | 'reused' | 'synthesized' | 'existing' | 'staged';
export type G1SettingsClip = { audio: Buffer; durationMs: number; origin: 'imported' | 'reused' | 'synthesized' };
export type G1SettingsRow = {
  account_id: string;
  slot: G1SettingsSlot;
  text: string;
  id: string;
  sha256: string;
  bytes: number;
  duration_ms: number;
  origin: G1SettingsOrigin;
};

/** 合同校验：RIFF 头可解析 / 24k·mono·16bit / ≤400 KiB / 槽时长上限。时长由 WAV 回读得出，不手填。 */
export function validateG1SettingsWav(slot: G1SettingsSlot, audio: Buffer): { ok: true; durationMs: number } | { ok: false; reason: string } {
  const info = parseWavHeader(audio);
  if (!info) return { ok: false, reason: 'bad_wav' };
  if (info.sampleRate !== G1_SETTINGS_WAV.sampleRate || info.channels !== G1_SETTINGS_WAV.channels || info.bitsPerSample !== G1_SETTINGS_WAV.bitsPerSample) {
    return { ok: false, reason: `bad_format:${info.sampleRate}/${info.channels}/${info.bitsPerSample}` };
  }
  if (audio.length > G1_SETTINGS_MAX_BYTES) return { ok: false, reason: `file_too_big:${audio.length}` };
  if (info.durationMs > G1_SETTINGS_MAX_MS[slot]) return { ok: false, reason: `too_long_audio:${info.durationMs}ms` };
  return { ok: true, durationMs: info.durationMs };
}

export type ResolveG1SettingsOpts = {
  /** 定稿字节（--from-dir 导入）：优先级最高，逐字节入库（与 APK 内置同源） */
  audio?: Partial<Record<G1SettingsSlot, Buffer>>;
  /** 合成函数注入（单测不走网络）；缺省讯飞 WAV 直出 */
  synthesize?: (text: string) => Promise<{ audio: Buffer; durationMs: number } | null>;
};

/** 取三句音频：导入字节 → 任一目标账号已有同文本 wav 条目（复用，含已 active）→ 合成一次。每槽最多一次 TTS。 */
export async function resolveG1SettingsClips(
  accountIds: string[],
  opts: ResolveG1SettingsOpts = {},
): Promise<{ clips: Partial<Record<G1SettingsSlot, G1SettingsClip>>; rejected: Array<{ slot: G1SettingsSlot; reason: string }> }> {
  assertLocalAudioWritesAllowed();
  const synth = opts.synthesize ?? synthesizeXfyunTtsWav;
  const clips: Partial<Record<G1SettingsSlot, G1SettingsClip>> = {};
  const rejected: Array<{ slot: G1SettingsSlot; reason: string }> = [];
  for (const slot of G1_SETTINGS_SLOTS) {
    const text = G1_SETTINGS_TEXTS[slot];
    let candidate: { audio: Buffer; origin: G1SettingsClip['origin'] } | null = null;
    const given = opts.audio?.[slot];
    if (given) candidate = { audio: given, origin: 'imported' };
    if (!candidate) {
      for (const acc of accountIds) {
        const existing = localAudioStore.findByText(acc, slot, text, 'wav');
        const audio = existing ? localAudioStore.readAudio(acc, existing.id, 'wav') : null;
        if (existing && audio) {
          localAudioStore.retainCandidate(acc, existing.id);
          candidate = { audio, origin: 'reused' };
          break;
        }
      }
    }
    if (!candidate) {
      const tts = await synth(text);
      if (!tts) {
        rejected.push({ slot, reason: 'tts_failed' });
        continue;
      }
      candidate = { audio: tts.audio, origin: 'synthesized' };
    }
    const v = validateG1SettingsWav(slot, candidate.audio);
    if (!v.ok) {
      rejected.push({ slot, reason: `${v.reason}(${candidate.origin})` });
      continue;
    }
    clips[slot] = { audio: candidate.audio, durationMs: v.durationMs, origin: candidate.origin };
  }
  return { clips, rejected };
}

/**
 * 扇出入 staging：每账号每槽一行，id = sha256 前 16 位。已有同 id 条目（含已 active）原样保留——insertItem 是
 * INSERT OR REPLACE 且 active=0，重跑绝不能把现役条目打回 staging。
 */
export function stageG1SettingsClips(accountIds: string[], clips: Partial<Record<G1SettingsSlot, G1SettingsClip>>): G1SettingsRow[] {
  assertLocalAudioWritesAllowed();
  const rows: G1SettingsRow[] = [];
  for (const account_id of accountIds) {
    for (const slot of G1_SETTINGS_SLOTS) {
      const clip = clips[slot];
      if (!clip) continue;
      const sha256 = crypto.createHash('sha256').update(clip.audio).digest('hex');
      const id = sha256.slice(0, 16);
      const text = G1_SETTINGS_TEXTS[slot];
      const existing = localAudioStore.getItem(account_id, id);
      if (existing) {
        rows.push({ account_id, slot, text, id, sha256, bytes: existing.bytes, duration_ms: existing.duration_ms, origin: 'existing' });
        continue;
      }
      localAudioStore.writeAudio(account_id, id, clip.audio, 'wav');
      localAudioStore.insertItem(account_id, { slot, id, text, sha256, bytes: clip.audio.length, duration_ms: clip.durationMs, format: 'wav' });
      rows.push({ account_id, slot, text, id, sha256, bytes: clip.audio.length, duration_ms: clip.durationMs, origin: clip.origin });
    }
  }
  return rows;
}

/** 该账号三句现状行（active 优先，其次 staging 同文本）——report / publish 用。 */
export function currentG1SettingsRows(accountId: string): G1SettingsRow[] {
  const active = localAudioStore.listActive(accountId);
  const out: G1SettingsRow[] = [];
  for (const slot of G1_SETTINGS_SLOTS) {
    const text = G1_SETTINGS_TEXTS[slot];
    const it = active.find((i) => i.slot === slot && i.format === 'wav') ?? localAudioStore.findByText(accountId, slot, text, 'wav');
    if (it) out.push({ account_id: accountId, slot, text, id: it.id, sha256: it.sha256, bytes: it.bytes, duration_ms: it.duration_ms, origin: it.active ? 'existing' : 'staged' });
  }
  return out;
}

/** 已 active 的三句（每槽最新一条）——日常再生成原样搬运（同 activeDeviceReplyKeep）。 */
export function activeG1SettingsKeep(accountId: string): Array<{ slot: G1SettingsSlot; id: string; bytes: number }> {
  const out: Array<{ slot: G1SettingsSlot; id: string; bytes: number }> = [];
  const active = localAudioStore.listActive(accountId);
  for (const slot of G1_SETTINGS_SLOTS) {
    const items = active.filter((i) => i.slot === slot && i.format === 'wav');
    if (items.length === 0) continue;
    const latest = items.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    out.push({ slot, id: latest.id, bytes: latest.bytes });
  }
  return out;
}

/** 显式发布：现役集合 ∪ 三句（按 slot:id 去重，重复发布内容未变不 bump）→ 新 revision。调用方先过三句齐全门与容量门。 */
export function publishG1Settings(accountId: string, rows: Array<Pick<G1SettingsRow, 'slot' | 'id'>>): { before: number; after: number | null } {
  const state = localAudioStore.getState(accountId);
  const seen = new Set<string>();
  const keep: Array<{ slot: G1SettingsRow['slot'] | ReturnType<typeof localAudioStore.listActive>[number]['slot']; id: string }> = [];
  for (const k of [...localAudioStore.listActive(accountId).map((i) => ({ slot: i.slot, id: i.id })), ...rows.map((r) => ({ slot: r.slot, id: r.id }))]) {
    const key = `${k.slot}:${k.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(k);
  }
  const after = localAudioStore.commitSet(accountId, keep, { tier: state.gen_tier, traits: state.gen_traits }, { expectedRevision: state.revision });
  return { before: state.revision, after };
}
