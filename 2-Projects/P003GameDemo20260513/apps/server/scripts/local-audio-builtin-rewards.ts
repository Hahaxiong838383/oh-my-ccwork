/**
 * 六条通用奖励基础音频（codex CODEX_CC_0001_AUTOMATIC_ACTIVATION_AND_AUDIO_V2_20260906 v2-B）离线合成 + 内置索引交付。
 * 这是 APK 内置兜底包的原料，**不入任何账号的 local_audio_item、不动 revision**——只出文件 + 索引 + tar.gz 到 inbox。
 * 生产跑法（/opt/p003/server）：
 *   set -a; . ./.env.local; set +a; npx tsx scripts/local-audio-builtin-rewards.ts <outDir> [--builtin-version <v>]
 * 门：WAV PCM16/mono/24kHz（讯飞小可音色同设备回复十八条），单条 ≤2200 ms、≤160 KiB；超限不截断不加速，直接记 rejected 回执改文案。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, ...rest] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: local-audio-builtin-rewards.ts <outDir> [--builtin-version <v>]');
  process.exit(2);
}
const bvIdx = rest.indexOf('--builtin-version');
const builtinVersion = bvIdx >= 0 ? rest[bvIdx + 1] : `rewards-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-1`;

const { synthesizeXfyunTtsWav, parseWavHeader } = await import('../src/providers/xfyun-tts.js');

/** codex v2-B 冻结文案（槽名沿用成长 manifest 的既有槽；coin=家族币，不恢复金币 Demo 语义） */
export const BUILTIN_REWARD_TEXTS: ReadonlyArray<{ slot: string; text: string }> = [
  { slot: 'g1.progress.coin_earned', text: '家族币可以领啦' },
  { slot: 'g1.progress.chest_earned', text: '宝箱可以打开啦' },
  { slot: 'g1.progress.final_earned', text: '今日大奖等你领' },
  { slot: 'g1.reward.coin_claimed', text: '家族币收好啦' },
  { slot: 'g1.reward.chest_claimed', text: '宝箱奖励收好啦' },
  { slot: 'g1.reward.final_claimed', text: '今日大奖收好啦' },
];
export const BUILTIN_REWARD_MAX_MS = 2200;
export const BUILTIN_REWARD_MAX_BYTES = 160 * 1024;

mkdirSync(outDir, { recursive: true });
type Row = { slot: string; file: string; text: string; sha256: string; bytes: number; duration_ms: number; sample_rate: number; channels: number; bits_per_sample: number };
const items: Row[] = [];
const rejected: Array<{ slot: string; text: string; reason: string }> = [];
for (const { slot, text } of BUILTIN_REWARD_TEXTS) {
  const tts = await synthesizeXfyunTtsWav(text);
  if (!tts) {
    rejected.push({ slot, text, reason: 'tts_failed' });
    continue;
  }
  const info = parseWavHeader(tts.audio);
  if (!info || info.sampleRate !== 24000 || info.channels !== 1 || info.bitsPerSample !== 16) {
    rejected.push({ slot, text, reason: `wav_format:${JSON.stringify(info)}` });
    continue;
  }
  if (info.durationMs > BUILTIN_REWARD_MAX_MS) {
    rejected.push({ slot, text, reason: `too_long_audio:${info.durationMs}ms` });
    continue;
  }
  if (tts.audio.length > BUILTIN_REWARD_MAX_BYTES) {
    rejected.push({ slot, text, reason: `file_too_big:${tts.audio.length}` });
    continue;
  }
  const file = `${slot}.wav`;
  writeFileSync(join(outDir, file), tts.audio);
  items.push({
    slot,
    file,
    text,
    sha256: createHash('sha256').update(tts.audio).digest('hex'),
    bytes: tts.audio.length,
    duration_ms: info.durationMs,
    sample_rate: info.sampleRate,
    channels: info.channels,
    bits_per_sample: info.bitsPerSample,
  });
}
const index = {
  schema_version: 1,
  builtin_version: builtinVersion,
  kind: 'g1_reward_builtin',
  generated_at: new Date().toISOString(),
  voice: process.env.XFYUN_TTS_VCN ?? '',
  items,
};
writeFileSync(join(outDir, 'builtin-index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(JSON.stringify({ ok: rejected.length === 0, builtin_version: builtinVersion, items: items.map((i) => ({ slot: i.slot, ms: i.duration_ms, bytes: i.bytes, sha: i.sha256.slice(0, 16) })), rejected }, null, 2));
process.exit(rejected.length === 0 ? 0 : 1);
