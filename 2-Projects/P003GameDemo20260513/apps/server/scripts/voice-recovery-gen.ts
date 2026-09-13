/**
 * B91 §2：端侧回落提示音「请再说一遍。」离线合成（正式小可音色）。
 *
 * 音色/参数与 64.90 worker `tts_xfyun.rs` 现役一致：讯飞 vcn=XFYUN_TTS_VCN（x6_lingxiaoxuan_pro）、
 * speed/volume/pitch=50、oral_level=mid、encoding=raw → PCM s16le/24k/mono → 44B RIFF（pcmToWav）。
 * 本地 .env.local 的 appid 是弃用凭据（音色未授权 11200），只能在生产 server 机上用生效凭据跑：
 *   cd /opt/p003/server && set -a; . ./.env.local; set +a; npx tsx scripts/voice-recovery-gen.ts --out /tmp/<dir> [--text 请再说一遍。]
 * 产物：<out>/repeat_request.wav + manifest.json（严格三键 {schema:1,text,sha256}）+ report.json（时长/电平/静音头尾/哈希，供回执）。
 * 门（任一不过即 exit 1 且不写产物）：24000Hz/1ch/16bit；时长 200..2400ms；非静音 peak≥3000 且 rms≥300；
 * 只裁静音：尾静音 >TAIL_MAX_MS 裁到 TAIL_KEEP_MS，头静音 >HEAD_MAX_MS 裁到 HEAD_KEEP_MS（不碰语音样本，不变速不变调）。
 * 不打印任何凭据。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k: string, d: string | null = null) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const outDir = arg('--out');
const text = arg('--text', '请再说一遍。') as string;
if (!outDir) {
  console.error('usage: voice-recovery-gen.ts --out <dir> [--text 请再说一遍。]');
  process.exit(2);
}

const SAMPLE_RATE = 24000;
const MIN_MS = 200;
const MAX_MS = 2400;
const SILENCE_ABS = 300; // |sample| 低于此视为静音（满幅 32767，≈ -41 dBFS）
const HEAD_MAX_MS = 150;
const HEAD_KEEP_MS = 60;
const TAIL_MAX_MS = 250;
const TAIL_KEEP_MS = 120;
const PEAK_MIN = 3000;
const RMS_MIN = 300;

const { synthesizeXfyunTtsWav, parseWavHeader, pcmToWav } = await import('../src/providers/xfyun-tts.js');

const res = await synthesizeXfyunTtsWav(text, 20000);
if (!res) {
  console.error('FAIL: tts 返回空（看上面的 [local-audio] tts 日志）');
  process.exit(1);
}
const info0 = parseWavHeader(res.audio);
if (!info0 || info0.sampleRate !== SAMPLE_RATE || info0.channels !== 1 || info0.bitsPerSample !== 16) {
  console.error('FAIL: 头格式不符', info0);
  process.exit(1);
}
const rawPcm = res.audio.subarray(44);
const n0 = rawPcm.length >> 1;
const sample = (buf: Buffer, i: number) => buf.readInt16LE(i * 2);

let head = 0;
while (head < n0 && Math.abs(sample(rawPcm, head)) < SILENCE_ABS) head++;
let tail = 0;
while (tail < n0 - head && Math.abs(sample(rawPcm, n0 - 1 - tail)) < SILENCE_ABS) tail++;
const msOf = (samples: number) => Math.round((samples / SAMPLE_RATE) * 1000);
const headMs0 = msOf(head);
const tailMs0 = msOf(tail);

const keepHead = headMs0 > HEAD_MAX_MS ? Math.round((HEAD_KEEP_MS / 1000) * SAMPLE_RATE) : head;
const keepTail = tailMs0 > TAIL_MAX_MS ? Math.round((TAIL_KEEP_MS / 1000) * SAMPLE_RATE) : tail;
const start = head - keepHead;
const end = n0 - (tail - keepTail);
const pcm = rawPcm.subarray(start * 2, end * 2);
const n = pcm.length >> 1;

let peak = 0;
let sumSq = 0;
for (let i = 0; i < n; i++) {
  const v = Math.abs(sample(pcm, i));
  if (v > peak) peak = v;
  sumSq += v * v;
}
const rms = Math.round(Math.sqrt(sumSq / Math.max(1, n)));
const dbfs = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v / 32767) * 10) / 10 : -Infinity);
const durationMs = msOf(n);

const report = {
  text,
  vcn: process.env.XFYUN_TTS_VCN ?? null,
  params: { speed: 50, volume: 50, pitch: 50, oral_level: 'mid', encoding: 'raw' },
  format: { sample_rate: SAMPLE_RATE, channels: 1, bits_per_sample: 16, codec: 'pcm_s16le' },
  raw: { bytes: res.audio.length, duration_ms: res.durationMs, head_silence_ms: headMs0, tail_silence_ms: tailMs0 },
  trimmed: { head_trimmed_ms: msOf(start), tail_trimmed_ms: msOf(n0 - end), head_silence_ms: msOf(keepHead), tail_silence_ms: msOf(keepTail) },
  final: { duration_ms: durationMs, peak, peak_dbfs: dbfs(peak), rms, rms_dbfs: dbfs(rms), bytes: 44 + pcm.length, sha256: '' },
  gates: { duration_ok: durationMs >= MIN_MS && durationMs <= MAX_MS, peak_ok: peak >= PEAK_MIN, rms_ok: rms >= RMS_MIN },
};
const failed = Object.entries(report.gates).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) {
  console.error('FAIL gates:', failed.join(','), JSON.stringify(report));
  process.exit(1);
}

const wav = pcmToWav(pcm);
const sha256 = createHash('sha256').update(wav).digest('hex');
report.final.sha256 = sha256;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'repeat_request.wav'), wav);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ schema: 1, text, sha256 }, null, 2) + '\n');
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
