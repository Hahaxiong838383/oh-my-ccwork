/**
 * G1 设置引导三句 离线导入/合成 · 预算 · 发布工具（Android codex 需求 2026-09-17）。生产在 /opt/p003/server 下跑：
 *   set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx scripts/local-audio-g1-settings.ts <accountId|--all> stage [--from-dir <dir>] [--json <path>]
 *   … report   （只读：三句现状行 + 候选 manifest 预算，不合成）
 *   … publish  （显式发布：现役集合 ∪ 三句 → 新 revision；三句不齐不发；容量门 ≤ REVISION_CAP_BYTES）
 * --from-dir：目录内 g1.settings.enter.wav / g1.settings.intro.wav / g1.settings.exit.wav 为定稿字节，逐字节入库（与 APK 内置同源）；
 *             无则复用已有同文本条目，再无则讯飞合成一次（同一份扇出）。
 * --all：local_audio_state 内 revision>0 的全部账号（灰度先单账号）。stdout 账号只打末 8 位。
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const target = args[0];
const mode = args[1] ?? 'report';
const opt = (k: string): string | null => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const fromDir = opt('--from-dir');
const jsonPath = opt('--json');
if (!target || !['stage', 'report', 'publish'].includes(mode)) {
  console.error('usage: local-audio-g1-settings.ts <accountId|--all> stage|report|publish [--from-dir <dir>] [--json <path>]');
  process.exit(2);
}

const { localAudioStore, G1_SETTINGS_SLOTS } = await import('../src/local-audio-store.js');
const { REVISION_CAP_BYTES } = await import('../src/local-audio-generator.js');
const { candidateManifestReport } = await import('../src/local-audio-device-reply.js');
const { resolveG1SettingsClips, stageG1SettingsClips, currentG1SettingsRows, publishG1Settings, G1_SETTINGS_TEXTS } = await import('../src/local-audio-g1-settings.js');
type Slot = (typeof G1_SETTINGS_SLOTS)[number];
type Row = ReturnType<typeof currentG1SettingsRows>[number];

const mask = (acc: string) => `…${acc.slice(-8)}`;
const accounts: string[] = target === '--all' ? localAudioStore.listAccounts() : [target];
if (accounts.length === 0) {
  console.error('no accounts');
  process.exit(2);
}

const rowsByAcc: Record<string, Row[]> = {};
let rejected: Array<{ slot: Slot; reason: string }> = [];
if (mode === 'stage') {
  const audio: Partial<Record<Slot, Buffer>> = {};
  if (fromDir) {
    for (const slot of G1_SETTINGS_SLOTS) {
      const p = `${fromDir}/${slot}.wav`;
      if (!existsSync(p)) {
        console.error(`missing ${p}`);
        process.exit(2);
      }
      audio[slot] = readFileSync(p);
    }
  }
  const r = await resolveG1SettingsClips(accounts, { audio });
  rejected = r.rejected;
  for (const row of stageG1SettingsClips(accounts, r.clips)) (rowsByAcc[row.account_id] ??= []).push(row);
} else {
  for (const acc of accounts) rowsByAcc[acc] = currentG1SettingsRows(acc);
}

const out: Array<Record<string, unknown>> = [];
for (const acc of accounts) {
  const rows = rowsByAcc[acc] ?? [];
  const report = candidateManifestReport(acc, rows, REVISION_CAP_BYTES);
  let published: { before: number; after: number | null } | null = null;
  if (mode === 'publish') {
    if (rows.length !== G1_SETTINGS_SLOTS.length) {
      console.error(`abort ${mask(acc)}: 三句不齐 ${rows.length}/${G1_SETTINGS_SLOTS.length}，不发布`);
      process.exitCode = 3;
      continue;
    }
    if (!report.within_cap) {
      console.error(`abort ${mask(acc)}: 候选 manifest ${report.candidate_bytes}B > ${REVISION_CAP_BYTES}B，不发布`);
      process.exitCode = 4;
      continue;
    }
    published = publishG1Settings(acc, rows);
    console.log(`published ${mask(acc)}: revision ${published.before} -> ${published.after ?? '(unchanged)'}`);
  }
  const manifest = localAudioStore.buildManifest(acc);
  const manifestSha = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  console.log(`account=${mask(acc)} mode=${mode} served_revision=${manifest.revision} manifest_sha256=${manifestSha} files=${report.candidate_unique_files} candidate_bytes=${report.candidate_bytes} within_cap=${report.within_cap}`);
  console.log('slot\ttext\tid\tbytes\tduration_ms\tsha256\torigin');
  for (const r of rows) console.log(`${r.slot}\t${r.text}\t${r.id}\t${r.bytes}\t${r.duration_ms}\t${r.sha256}\t${r.origin}`);
  out.push({ account_suffix: acc.slice(-8), mode, published, served_revision: manifest.revision, manifest_sha256: manifestSha, rows, report, served_manifest: manifest });
}
if (rejected.length) console.log('REJECTED', JSON.stringify(rejected));
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ generated_at: new Date().toISOString(), texts: G1_SETTINGS_TEXTS, accounts: out }, null, 2));
  console.log(`json written: ${jsonPath}`);
}
