/**
 * 设备回复十八条（合同 v3.1 §5）离线合成 / 预算 / 发布工具。生产在 /opt/p003/server 下跑：
 *   set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx scripts/local-audio-device-reply.ts <accountId> stage [--json <path>]
 *   … publish   （显式发布：现役集合 ∪ 十八条 → 新 revision；容量门 ≤ REVISION_CAP_BYTES；十八条不齐不发）
 *   … report    （只读：候选 manifest 预算，不合成）
 * stage 只入 staging（active=0），不改现役 revision；输出逐条 slot/text/id/bytes/duration/sha256 与候选 manifest 求和。
 */
import { writeFileSync } from 'node:fs';
const [accountId, mode = 'report', ...rest] = process.argv.slice(2);
if (!accountId) {
  console.error('usage: local-audio-device-reply.ts <accountId> stage|publish|report [--json <path>]');
  process.exit(2);
}
const jsonIdx = rest.indexOf('--json');
const jsonPath = jsonIdx >= 0 ? rest[jsonIdx + 1] : null;

const { localAudioStore, DEVICE_REPLY_SLOTS } = await import('../src/local-audio-store.js');
const { REVISION_CAP_BYTES } = await import('../src/local-audio-generator.js');
const { stageDeviceReplyClips, candidateManifestReport, DEVICE_REPLY_TEXTS } = await import('../src/local-audio-device-reply.js');

function currentRows() {
  const active = localAudioStore.listActive(accountId);
  return DEVICE_REPLY_SLOTS.flatMap((slot) => {
    const text = DEVICE_REPLY_TEXTS[slot];
    const it = active.find((i) => i.slot === slot && i.format === 'wav') ?? localAudioStore.findByText(accountId, slot, text, 'wav');
    return it ? [{ slot, text, id: it.id, sha256: it.sha256, bytes: it.bytes, duration_ms: it.duration_ms, origin: it.active ? 'active' : 'staged' }] : [];
  });
}

let rows: Array<{ slot: string; text: string; id: string; sha256: string; bytes: number; duration_ms: number; origin: string }> = [];
let rejected: Array<{ slot: string; reason: string }> = [];
if (mode === 'stage') {
  const r = await stageDeviceReplyClips(accountId);
  rows = r.rows;
  rejected = r.rejected;
} else {
  rows = currentRows();
}
const report = candidateManifestReport(accountId, rows, REVISION_CAP_BYTES);

if (mode === 'publish') {
  if (rows.length !== DEVICE_REPLY_SLOTS.length) {
    console.error(`abort: 十八条不齐（${rows.length}/${DEVICE_REPLY_SLOTS.length}），不发布`);
    process.exit(3);
  }
  if (!report.within_cap) {
    console.error(`abort: 候选 manifest ${report.candidate_bytes}B > ${REVISION_CAP_BYTES}B，不发布`);
    process.exit(4);
  }
  const state = localAudioStore.getState(accountId);
  const keep = [
    ...localAudioStore.listActive(accountId).map((i) => ({ slot: i.slot, id: i.id })),
    ...rows.map((r) => ({ slot: r.slot as (typeof DEVICE_REPLY_SLOTS)[number], id: r.id })),
  ];
  const revision = localAudioStore.commitSet(accountId, keep, { tier: state.gen_tier, traits: state.gen_traits }, { expectedRevision: state.revision });
  console.log(`published: revision ${state.revision} -> ${revision ?? '(unchanged)'}`);
}

console.log('slot\ttext\tid\tbytes\tduration_ms\tsha256\torigin');
for (const r of rows) console.log(`${r.slot}\t${r.text}\t${r.id}\t${r.bytes}\t${r.duration_ms}\t${r.sha256}\t${r.origin}`);
if (rejected.length) console.log('REJECTED', JSON.stringify(rejected));
console.log('REPORT', JSON.stringify(report));
if (jsonPath) {
  const manifest = localAudioStore.buildManifest(accountId);
  writeFileSync(jsonPath, JSON.stringify({ generated_at: new Date().toISOString(), mode, account_suffix: accountId.slice(-4), served_manifest: manifest, device_reply: rows, rejected, report }, null, 2));
  console.log(`json written: ${jsonPath}`);
}
