import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const moduleUrl = new URL('./storage-nas-verify.mjs', import.meta.url);
assert(fs.existsSync(moduleUrl), 'NAS verification is not implemented');
const { prepare, finalize, acknowledge, validate } = await import(moduleUrl);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nas-verify-')));
const payload = Buffer.from('committed real file content\n'.repeat(100));
const meta = { schema_version: 1, archive_id: 'a'.repeat(32), kind: 'transfer_probe', created_at_ms: 1,
  record_count: 100, bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex'), source_range: {} };
try {
  const manifest = path.join(root, 'input.json'); fs.writeFileSync(manifest, JSON.stringify(meta));
  let p = prepare(root, manifest);
  assert.equal(p.offset, 0); fs.writeFileSync(p.payload, payload.subarray(0, 23));
  p = prepare(root, manifest); assert.equal(p.offset, 23);
  fs.appendFileSync(p.payload, payload.subarray(23));
  const final = await finalize(root, meta.archive_id);
  assert.equal(final.sha256, meta.sha256);
  assert.equal(prepare(root, manifest).complete, true);
  const originalSync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('FSYNC_FAILURE'); };
    await assert.rejects(finalize(root, meta.archive_id), /FSYNC_FAILURE/, 'completed retry must still make the rename durable before ACK');
  } finally { fs.fsyncSync = originalSync; }
  assert.equal(fs.existsSync(path.join(root, 'packages', meta.archive_id, 'receipt.json')), false);
  const receipt = { archive_id: meta.archive_id, bytes: meta.bytes, sha256: meta.sha256, record_count: meta.record_count, verified_at_ms: 2 };
  acknowledge(root, meta.archive_id, receipt); acknowledge(root, meta.archive_id, receipt);
  assert.throws(() => acknowledge(root, meta.archive_id, { ...receipt, sha256: 'f'.repeat(64) }));
  assert.throws(() => acknowledge(root, meta.archive_id, { ...receipt, record_count: meta.record_count + 1 }));
  assert.throws(() => validate({ ...meta, archive_id: '../escape' }));
  assert.throws(() => validate({ ...meta, record_count: true }));
  assert.throws(() => validate({ ...meta, bytes: 1.5 }));
  assert.throws(() => validate({ ...meta, unknown: true }));
  const second = { ...meta, archive_id: 'b'.repeat(32) };
  fs.writeFileSync(manifest, JSON.stringify(second)); p = prepare(root, manifest);
  fs.writeFileSync(p.payload, Buffer.alloc(payload.length, 1));
  await assert.rejects(finalize(root, second.archive_id), /CHECKSUM/);
  assert(!fs.existsSync(path.join(root, 'packages', second.archive_id)));
  assert.equal(prepare(root, manifest).offset, 0, 'corrupt partial quarantined; clean retry starts at zero');
  const third = { ...meta, archive_id: 'c'.repeat(32) };
  fs.writeFileSync(manifest, JSON.stringify(third)); p = prepare(root, manifest);
  fs.unlinkSync(p.payload); fs.symlinkSync(manifest, p.payload);
  assert.throws(() => prepare(root, manifest), /REGULAR/);
  const fourth = { ...meta, archive_id: 'd'.repeat(32) };
  fs.writeFileSync(manifest, JSON.stringify(fourth)); p = prepare(root, manifest);
  fs.writeFileSync(p.payload, Buffer.alloc(payload.length + 1));
  assert.throws(() => prepare(root, manifest), /OVERSIZE/);
  assert.equal(prepare(root, manifest).offset, 0, 'oversized partial quarantined for a clean retry');
  const dbFile = path.join(root, 'fixture.sqlite3');
  const db = new DatabaseSync(dbFile); db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY); INSERT INTO events VALUES(1),(2)'); db.close();
  const bytes = fs.readFileSync(dbFile);
  const sqlMeta = { ...meta, archive_id: 'e'.repeat(32), kind: 'analytics_backup', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), record_count: 3, source_range: { tables: { events: 3 } } };
  fs.writeFileSync(manifest, JSON.stringify(sqlMeta)); p = prepare(root, manifest); fs.writeFileSync(p.payload, bytes);
  await assert.rejects(finalize(root, sqlMeta.archive_id), /ROW_COUNT/, 'equal file hash does not excuse a false manifest count');
  const correct = { ...sqlMeta, archive_id: 'f'.repeat(32), record_count: 2, source_range: { tables: { events: 2 } } };
  fs.writeFileSync(manifest, JSON.stringify(correct)); p = prepare(root, manifest); fs.writeFileSync(p.payload, bytes);
  assert.equal((await finalize(root, correct.archive_id)).record_count, 2);
  console.log('PASS: NAS partial resume, atomic finalize, lost-ACK retry, corruption quarantine, schema and symlink rejection');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
