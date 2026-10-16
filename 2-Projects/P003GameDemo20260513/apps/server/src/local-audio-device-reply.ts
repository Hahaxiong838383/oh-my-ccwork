import { assertLocalAudioWritesAllowed } from './local-audio-integrity.js';
/**
 * 设备回复本地短句（合同 v3.1 §5 · codex 阶段 B GO §3 定稿十八条，2026-09-05）。
 *
 * 与 14 个人格槽不同：文本**冻结**（两端同表，不走 LLM、不润色），每槽 1 条、optional；
 * WAV PCM16 / mono / 24 kHz，单条 ≤160 KiB，时长 ≤3200 ms（建议 ≤2400 ms）；
 * 合成后只入 staging（active=0），**发布必须显式**（新的不可变 revision），日常再生成只搬运已 active 的条目，
 * 绝不自动把 staging 的设备回复条目提为 active。
 *
 * 与 worker `pipeline.rs::device_reply` 话术表同源：改文本先改合同再两端同步。
 */
import crypto from 'node:crypto';
import { synthesizeXfyunTtsWav } from './providers/xfyun-tts.js';
import {
  DEVICE_REPLY_SLOTS,
  localAudioStore,
  LOCAL_AUDIO_SLOTS,
  MIN_ITEMS_PER_SLOT,
  type DeviceReplySlot,
  type LocalAudioItem,
} from './local-audio-store.js';

/** 十八条冻结文本（codex 2026-09-05 §3；第 2/15/16 条为 codex 调整后终值）。 */
export const DEVICE_REPLY_TEXTS: Readonly<Record<DeviceReplySlot, string>> = {
  'device_reply.applied_relative': '好嘞，调好啦',
  'device_reply.applied_absolute': '好的，已经调好了',
  'device_reply.applied_unconfirmed': '已发送调整，暂未确认',
  'device_reply.already': '现在就是这样啦',
  'device_reply.boundary.virtual_image_far': '画面已经是最远的了',
  'device_reply.boundary.virtual_image_near': '画面已经是最近的了',
  'device_reply.boundary.brightness_max': '亮度已经是最高了',
  'device_reply.boundary.brightness_min': '亮度已经是最低了',
  'device_reply.boundary.color_temperature_warm': '色温已经是最暖的了',
  'device_reply.boundary.color_temperature_cold': '色温已经是最冷的了',
  'device_reply.boundary.volume_max': '音量已经是最大了',
  'device_reply.boundary.volume_min': '音量已经是最小了',
  'device_reply.boundary.height_max': '高度已经是最高了',
  'device_reply.boundary.height_min': '高度已经是最低了',
  'device_reply.boundary.generic': '已经调到头啦',
  'device_reply.not_now': '现在暂时不能这样调',
  'device_reply.failed': '暂时没能确认调整结果',
  'device_reply.unsupported_motor': '这台设备不支持调画面距离',
};

export const DEVICE_REPLY_MAX_BYTES = 160 * 1024;
export const DEVICE_REPLY_MAX_MS = 3200;
export const DEVICE_REPLY_ITEMS_PER_SLOT = 1;

export type DeviceReplyRow = {
  slot: DeviceReplySlot;
  text: string;
  id: string;
  sha256: string;
  bytes: number;
  duration_ms: number;
  /** reused=同文本 wav 条目已存在(含 active),不重合成;synthesized=本轮新合成 */
  origin: 'reused' | 'synthesized';
};

export type DeviceReplyStageResult = {
  rows: DeviceReplyRow[];
  rejected: Array<{ slot: DeviceReplySlot; reason: string }>;
};

/** 已 active 的设备回复条目（每槽取最新一条）——日常再生成时原样搬运，保证不因人格槽换新而丢。 */
export function activeDeviceReplyKeep(accountId: string): Array<{ slot: DeviceReplySlot; id: string; bytes: number }> {
  const out: Array<{ slot: DeviceReplySlot; id: string; bytes: number }> = [];
  const active = localAudioStore.listActive(accountId);
  for (const slot of DEVICE_REPLY_SLOTS) {
    const items = active.filter((i) => i.slot === slot && i.format === 'wav');
    if (items.length === 0) continue;
    const latest = items.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    out.push({ slot, id: latest.id, bytes: latest.bytes });
  }
  return out;
}

/** 十八条合成/复用入 staging（active=0）。同文本已有 wav 条目直接复用（TTS 非确定性，重合成=白换 id）。 */
export async function stageDeviceReplyClips(accountId: string): Promise<DeviceReplyStageResult> {
  assertLocalAudioWritesAllowed();
  const rows: DeviceReplyRow[] = [];
  const rejected: Array<{ slot: DeviceReplySlot; reason: string }> = [];
  for (const slot of DEVICE_REPLY_SLOTS) {
    const text = DEVICE_REPLY_TEXTS[slot];
    const existing = localAudioStore.findByText(accountId, slot, text, 'wav');
    if (existing) {
      localAudioStore.retainCandidate(accountId, existing.id);
      rows.push({ slot, text, id: existing.id, sha256: existing.sha256, bytes: existing.bytes, duration_ms: existing.duration_ms, origin: 'reused' });
      continue;
    }
    const tts = await synthesizeXfyunTtsWav(text);
    if (!tts) {
      rejected.push({ slot, reason: 'tts_failed' });
      continue;
    }
    if (tts.durationMs > DEVICE_REPLY_MAX_MS) {
      rejected.push({ slot, reason: `too_long_audio:${tts.durationMs}ms` });
      continue;
    }
    if (tts.audio.length > DEVICE_REPLY_MAX_BYTES) {
      rejected.push({ slot, reason: `file_too_big:${tts.audio.length}` });
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(tts.audio).digest('hex');
    const id = sha256.slice(0, 16);
    localAudioStore.writeAudio(accountId, id, tts.audio, 'wav');
    localAudioStore.insertItem(accountId, { slot, id, text, sha256, bytes: tts.audio.length, duration_ms: tts.durationMs, format: 'wav' });
    rows.push({ slot, text, id, sha256, bytes: tts.audio.length, duration_ms: tts.durationMs, origin: 'synthesized' });
  }
  return { rows, rejected };
}

export type CandidateManifestReport = {
  /** 现役 revision（buildManifest 实际下发的集合） */
  revision: number;
  active_items: number;
  active_bytes: number;
  /** 旧 14 槽各自的现役条目数（未丢失证明：required 六槽 ≥ MIN_ITEMS_PER_SLOT） */
  old_slot_counts: Record<string, number>;
  old_slots_short: string[];
  /** 十八条（staging 或已 active）各 1 条 */
  device_reply_items: number;
  device_reply_bytes: number;
  /** 候选 manifest = 现役集合 ∪ 十八条，按 id 去重求和 */
  candidate_unique_files: number;
  candidate_bytes: number;
  cap_bytes: number;
  within_cap: boolean;
  headroom_bytes: number;
};

/** 完整候选 manifest 预算：按 **buildManifest 实际引用的现役集合** ∪ 十八条，去重求和；不用「每槽最近 2 条」推断。 */
export function candidateManifestReport(accountId: string, deviceReply: Array<Pick<DeviceReplyRow, 'id' | 'bytes'>>, capBytes: number): CandidateManifestReport {
  const manifest = localAudioStore.buildManifest(accountId);
  const active: LocalAudioItem[] = localAudioStore.listActive(accountId);
  const seen = new Map<string, number>();
  for (const it of active) seen.set(it.id, it.bytes);
  const activeBytes = [...seen.values()].reduce((a, b) => a + b, 0);
  const oldSlotCounts: Record<string, number> = {};
  for (const slot of LOCAL_AUDIO_SLOTS) oldSlotCounts[slot] = (manifest.slots[slot] ?? []).length;
  const short = LOCAL_AUDIO_SLOTS.filter((s) => oldSlotCounts[s] > 0 && oldSlotCounts[s] < MIN_ITEMS_PER_SLOT).map(String);
  let drBytes = 0;
  for (const r of deviceReply) {
    drBytes += r.bytes;
    if (!seen.has(r.id)) seen.set(r.id, r.bytes);
  }
  const candidateBytes = [...seen.values()].reduce((a, b) => a + b, 0);
  return {
    revision: manifest.revision,
    active_items: active.length,
    active_bytes: activeBytes,
    old_slot_counts: oldSlotCounts,
    old_slots_short: short,
    device_reply_items: deviceReply.length,
    device_reply_bytes: drBytes,
    candidate_unique_files: seen.size,
    candidate_bytes: candidateBytes,
    cap_bytes: capBytes,
    within_cap: candidateBytes <= capBytes,
    headroom_bytes: capBytes - candidateBytes,
  };
}
