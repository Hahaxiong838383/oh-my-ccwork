import { createHash } from 'node:crypto';

export const LOCAL_AUDIO_SLOTS = [
  'greeting.normal',
  'greeting.cover_open',
  'greeting.presence_return',
  'farewell.general',
  'farewell.goodbye',
  'farewell.night',
  'posture.adjust',
  'posture.no_face',
  // v133 G1 奖励线（optional，合同 CODEX_CC_P003_G1_LOCAL_AUDIO_V133_JOINT_20260828 §2）：
  // 进度段完成（*.earned）与领取事务成功（*.claimed）各三档，缺失=合法（端侧只记 state=missing）
  'g1.progress.coin_earned',
  'g1.progress.chest_earned',
  'g1.progress.final_earned',
  'g1.reward.coin_claimed',
  'g1.reward.chest_claimed',
  'g1.reward.final_claimed',
] as const;
export type LocalAudioSlot = (typeof LOCAL_AUDIO_SLOTS)[number];

/**
 * 设备回复槽（合同 v3.1 §5，codex 2026-09-05 定稿 18 条）：文本冻结、每槽 1 条、optional。
 * 不进 LLM 生成循环（LOCAL_AUDIO_SLOTS 不含），只由 local-audio-device-reply.ts 显式 stage / 发布；
 * 日常再生成只搬运已 active 的条目。文本真源见 DEVICE_REPLY_TEXTS。
 */
export const DEVICE_REPLY_SLOTS = [
  'device_reply.applied_relative',
  'device_reply.applied_absolute',
  'device_reply.applied_unconfirmed',
  'device_reply.already',
  'device_reply.boundary.virtual_image_far',
  'device_reply.boundary.virtual_image_near',
  'device_reply.boundary.brightness_max',
  'device_reply.boundary.brightness_min',
  'device_reply.boundary.color_temperature_warm',
  'device_reply.boundary.color_temperature_cold',
  'device_reply.boundary.volume_max',
  'device_reply.boundary.volume_min',
  'device_reply.boundary.height_max',
  'device_reply.boundary.height_min',
  'device_reply.boundary.generic',
  'device_reply.not_now',
  'device_reply.failed',
  'device_reply.unsupported_motor',
] as const;
export type DeviceReplySlot = (typeof DEVICE_REPLY_SLOTS)[number];
/**
 * G1 设置引导三句（Android codex 需求 2026-09-17）：文本冻结、每槽 1 条、optional；同十八条不进 LLM 循环，
 * 只由 local-audio-g1-settings.ts 显式 stage / 发布（合成一次、同字节扇出全机队）；文本真源 G1_SETTINGS_TEXTS。
 */
export const G1_SETTINGS_SLOTS = ['g1.settings.enter', 'g1.settings.intro', 'g1.settings.exit'] as const;
export type G1SettingsSlot = (typeof G1_SETTINGS_SLOTS)[number];
/** 条目可落的全部槽（人格 14 + 设备回复 18 + G1 设置引导 3） */
export type AnyAudioSlot = LocalAudioSlot | DeviceReplySlot | G1SettingsSlot;

/**
 * 必选六 slot（v107 合同 §1：required 缺任一即整套 abort）。
 * posture.* 为 optional：缺失=合法（v107 端侧回退 APK 内置），但一旦出现必须 2..5 条——
 * 单条不成套（发布门会弃 1 条的 optional slot，条目留 staging 下轮补足后再进）。
 */
export const REQUIRED_SLOTS: readonly LocalAudioSlot[] = [
  'greeting.normal',
  'greeting.cover_open',
  'greeting.presence_return',
  'farewell.general',
  'farewell.goodbye',
  'farewell.night',
] as const;

export const MIN_ITEMS_PER_SLOT = 2;


export type LocalAudioItem = {
  slot: AnyAudioSlot;
  id: string;
  text: string;
  sha256: string;
  bytes: number;
  duration_ms: number;
  format: 'mp3' | 'wav'; // WAV 合同增量：rev=1 存量=mp3（冻结回滚锚），rev≥2 新发布=wav
  created_at: number;
  active: number;
};


export class LocalAudioIntegrityError extends Error {
  constructor(public readonly code: string, detail = '') { super(detail ? `${code}:${detail}` : code); }
}
export function fail(code: string, detail = ''): never { throw new LocalAudioIntegrityError(code, detail); }
export function assertLocalAudioWritesAllowed(): void {
  if (process.env.LOCAL_AUDIO_WRITES_PAUSED === '1') fail('local_audio_writes_paused');
}
export const PUBLICATION_CAP_BYTES = 5 * 1024 * 1024;
const MAX_MS: Record<string, number> = {
  'greeting.normal': 1800, 'greeting.cover_open': 2400, 'greeting.presence_return': 2400,
  'farewell.general': 2800, 'farewell.goodbye': 2800, 'farewell.night': 2800,
  'posture.adjust': 3200, 'posture.no_face': 3200,
  'g1.settings.enter': 3000, 'g1.settings.intro': 8000, 'g1.settings.exit': 5500,
};
export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const ALL_SLOTS: readonly string[] = [...LOCAL_AUDIO_SLOTS, ...DEVICE_REPLY_SLOTS, ...G1_SETTINGS_SLOTS];
export function validateClipMetadata(item: Omit<LocalAudioItem, 'created_at' | 'active'>): void {
  if (!ALL_SLOTS.includes(item.slot) || !/^[0-9a-f]{16}$/.test(item.id) || !/^[0-9a-f]{64}$/.test(item.sha256)
    || !item.text.trim() || !Number.isSafeInteger(item.bytes) || item.bytes <= 44
    || !Number.isSafeInteger(item.duration_ms) || item.duration_ms <= 0 || item.format !== 'wav') fail('invalid_clip_metadata');
  const maxMs = MAX_MS[item.slot] ?? (item.slot.startsWith('device_reply.') ? 3200 : 2200);
  if (item.duration_ms > maxMs) fail('clip_duration_limit', item.slot);
  if (item.bytes > (item.slot.startsWith('g1.settings.') ? 400 : 160) * 1024) fail('clip_size_limit', item.slot);
}
/** 严格解析 RIFF 各 chunk，不接受截断、假 data 长度、非 PCM 或与清单不一致的时长。 */
export function validateClipBytes(item: Omit<LocalAudioItem, 'created_at' | 'active'>, audio: Buffer): void {
  validateClipMetadata(item);
  if (audio.length !== item.bytes || sha256(audio) !== item.sha256) fail('clip_file_mismatch', item.id);
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE'
    || audio.readUInt32LE(4) + 8 !== audio.length) fail('invalid_wav', item.id);
  let fmt = false, dataBytes = 0, dataSeen = false, offset = 12;
  while (offset + 8 <= audio.length) {
    const tag = audio.toString('ascii', offset, offset + 4), size = audio.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > audio.length) fail('invalid_wav', item.id);
    if (tag === 'fmt ') {
      if (fmt || size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1
        || audio.readUInt32LE(start + 4) !== 24000 || audio.readUInt32LE(start + 8) !== 48000
        || audio.readUInt16LE(start + 12) !== 2 || audio.readUInt16LE(start + 14) !== 16) fail('invalid_wav', item.id);
      fmt = true;
    }
    if (tag === 'data') { if (dataSeen || size === 0 || size % 2) fail('invalid_wav', item.id); dataSeen = true; dataBytes = size; }
    offset = start + size + (size % 2);
  }
  if (!fmt || !dataSeen || offset !== audio.length || Math.round(dataBytes / 48) !== item.duration_ms) fail('invalid_wav', item.id);
}
export function validatePublicationItems(items: ReadonlyArray<LocalAudioItem>): void {
  const ids = new Set<string>(), counts = new Map<string, number>();
  let bytes = 0;
  for (const item of items) {
    validateClipMetadata(item);
    if (ids.has(item.id)) fail('duplicate_clip_id', item.id);
    ids.add(item.id); bytes += item.bytes;
    counts.set(item.slot, (counts.get(item.slot) ?? 0) + 1);
  }
  for (const slot of REQUIRED_SLOTS) if (!counts.has(slot)) fail('invalid_slot_count', slot);
  for (const [slot, n] of counts) {
    const fixed = slot.startsWith('device_reply.') || slot.startsWith('g1.settings.');
    if (fixed ? n !== 1 : n < 2 || n > 5) fail('invalid_slot_count', slot);
  }
  if (bytes > PUBLICATION_CAP_BYTES) fail('publication_size_limit');
}
export function sameClipMetadata(a: Omit<LocalAudioItem, 'created_at' | 'active'>, b: Omit<LocalAudioItem, 'created_at' | 'active'>): boolean {
  return (['slot', 'id', 'text', 'sha256', 'bytes', 'duration_ms', 'format'] as const).every(k => a[k] === b[k]);
}
