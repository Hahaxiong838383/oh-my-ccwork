// Filesystem-only verifier. On PRnas run in the existing pinned Node container
// with --network none, no capabilities, and only the archive directory mounted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const keys = ['schema_version', 'archive_id', 'kind', 'created_at_ms', 'record_count', 'bytes', 'sha256', 'source_range'].sort();
const kinds = ['analytics_backup', 'ark_checkpoint', 'transfer_probe'];
const fail = message => { throw new Error(message); };
const regular = p => { const s = fs.lstatSync(p); if (!s.isFile() || s.isSymbolicLink()) fail('NOT_REGULAR'); return s; };
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const syncDir = p => { const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
function dir(p) {
  if (!exists(p)) fs.mkdirSync(p, { mode: 0o700 });
  const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
}
function setup(root) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root) fail('UNSAFE_ROOT');
  for (const n of ['incoming', 'packages', 'quarantine']) dir(path.join(root, n));
}
function json(p) { if (regular(p).size > 8192) fail('MANIFEST_TOO_LARGE'); return JSON.parse(fs.readFileSync(p, 'utf8')); }
function durableJson(p, data) {
  const tmp = p + '.' + randomUUID(); const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p); syncDir(path.dirname(p));
}
export function validate(m) {
  if (!m || Array.isArray(m) || Object.keys(m).sort().join(',') !== keys.join(',')) fail('INVALID_MANIFEST');
  if (m.schema_version !== 1 || typeof m.archive_id !== 'string' || !ID.test(m.archive_id) || !kinds.includes(m.kind)
      || typeof m.sha256 !== 'string' || !HASH.test(m.sha256)) fail('INVALID_MANIFEST');
  for (const k of ['bytes', 'record_count', 'created_at_ms']) if (!Number.isSafeInteger(m[k]) || m[k] < 0) fail('INVALID_NUMBER');
  if (!m.bytes || m.bytes > 256 * 1024 ** 3 || !m.source_range || Array.isArray(m.source_range)
      || typeof m.source_range !== 'object' || Buffer.byteLength(JSON.stringify(m)) > 8192) fail('INVALID_RANGE');
  return m;
}
function packagePath(root, id, staging = false) {
  if (!ID.test(id)) fail('INVALID_ID');
  const p = path.join(root, staging ? 'incoming' : 'packages', id);
  if (exists(p) && fs.lstatSync(p).isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  return p;
}
async function checksum(p) {
  regular(p); const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyRows(m, payload) {
  if (m.kind !== 'analytics_backup') return;
  const tables = m.source_range.tables;
  if (!tables || Array.isArray(tables) || typeof tables !== 'object' || !Object.keys(tables).length || Object.keys(tables).length > 100) fail('INVALID_TABLE_COUNTS');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(payload, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('SQLITE_INTEGRITY');
    let total = 0;
    for (const [name, expected] of Object.entries(tables)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !Number.isSafeInteger(expected) || expected < 0) fail('INVALID_TABLE_COUNTS');
      const actual = db.prepare('SELECT count(*) AS n FROM "' + name + '"').get().n;
      if (actual !== expected) fail('ROW_COUNT_MISMATCH');
      total += actual;
    }
    if (total !== m.record_count) fail('ROW_COUNT_MISMATCH');
  } finally { db.close(); }
}
function equalManifest(a, b) {
  // Remote manifests are immutable and serialized deterministically by the gateway.
  if (JSON.stringify(a) !== JSON.stringify(b)) fail('MANIFEST_CHANGED');
}
function quarantine(root, stage, id) {
  fs.renameSync(stage, path.join(root, 'quarantine', id + '-' + randomUUID()));
  syncDir(path.join(root, 'incoming')); syncDir(path.join(root, 'quarantine'));
}
export function prepare(root, manifestFile) {
  setup(root); const m = validate(json(manifestFile));
  const final = packagePath(root, m.archive_id);
  if (exists(final)) {
    equalManifest(validate(json(path.join(final, 'manifest.json'))), m);
    if (regular(path.join(final, 'payload.bin')).size !== m.bytes) fail('FINAL_SIZE_MISMATCH');
    return { ...m, offset: m.bytes, complete: true, payload: path.join(final, 'payload.bin') };
  }
  const stage = packagePath(root, m.archive_id, true); dir(stage);
  const localManifest = path.join(stage, 'manifest.json');
  if (exists(localManifest)) equalManifest(validate(json(localManifest)), m);
  else durableJson(localManifest, m);
  const payload = path.join(stage, 'payload.bin');
  if (!exists(payload)) { const fd = fs.openSync(payload, 'wx', 0o600); fs.closeSync(fd); }
  const offset = regular(payload).size;
  if (offset > m.bytes) { quarantine(root, stage, m.archive_id); fail('PARTIAL_OVERSIZE'); }
  return { ...m, offset, complete: false, payload };
}
export async function finalize(root, id) {
  setup(root); const final = packagePath(root, id); const stage = packagePath(root, id, true);
  const folder = exists(final) ? final : stage;
  const m = validate(json(path.join(folder, 'manifest.json')));
  if (m.archive_id !== id) fail('MANIFEST_ID_MISMATCH');
  const p = path.join(folder, 'payload.bin');
  if (regular(p).size !== m.bytes || await checksum(p) !== m.sha256) {
    if (folder === stage) {
      quarantine(root, stage, id);
    }
    fail('CHECKSUM_MISMATCH');
  }
  await verifyRows(m, p);
  // Repeat durability barriers after restart/ACK loss, including a previous
  // rename that succeeded just before its directory fsync failed.
  for (const file of ['payload.bin', 'manifest.json']) {
    const fd = fs.openSync(path.join(folder, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  syncDir(folder);
  if (folder === stage) {
    fs.renameSync(stage, final);
  }
  syncDir(path.join(root, 'incoming')); syncDir(path.join(root, 'packages')); syncDir(root);
  return m;
}
export function acknowledge(root, id, receipt) {
  setup(root); const folder = packagePath(root, id); const m = validate(json(path.join(folder, 'manifest.json')));
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'archive_id,bytes,record_count,sha256,verified_at_ms'
      || receipt.archive_id !== id || receipt.sha256 !== m.sha256 || receipt.bytes !== m.bytes || receipt.record_count !== m.record_count
      || !Number.isSafeInteger(receipt.verified_at_ms) || receipt.verified_at_ms < 0) fail('ACK_MISMATCH');
  durableJson(path.join(folder, 'receipt.json'), receipt);
}
async function main() {
  const [command, root, arg, extra] = process.argv.slice(2);
  if (command === 'prepare') {
    const m = prepare(root, arg);
    console.log([m.archive_id, m.sha256, m.bytes, m.offset, m.complete ? 1 : 0, m.record_count].join('\t'));
  } else if (command === 'finalize') console.log(JSON.stringify(await finalize(root, arg)));
  else if (command === 'ack') { acknowledge(root, arg, json(extra)); console.log('ACK_STORED'); }
  else fail('INVALID_COMMAND');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('ARCHIVE_VERIFY_FAILED:' + e.message); process.exitCode = 1; });
}
