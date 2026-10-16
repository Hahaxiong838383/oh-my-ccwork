import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'la-integrity-'));
process.env.PROFILE_DB_PATH = join(dir, 'profile.db');
for (const key of ['CONFIG','CONVERSATION','ACCOUNTS','FEEDBACK','DIAGNOSTICS','OTA','PAIRING','SMS','TELEMETRY']) process.env[`${key}_DB_PATH`] = join(dir, `${key.toLowerCase()}.db`);
process.env.DEVICES_DB_PATH = join(dir, 'devices.db');
process.env.LOCAL_AUDIO_DIR = join(dir, 'audio');
process.env.LOCAL_AUDIO_WRITES_PAUSED = '0';
const { localAudioStore: store, REQUIRED_SLOTS } = await import('../src/local-audio-store.js');
const { pcmToWav } = await import('../src/providers/xfyun-tts.js');
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const wav = pcmToWav(Buffer.alloc(48000));
const acc = 'integrity-test';
const gen = { tier: '新朋友', traits: '{}' };
const item = { slot: 'greeting.cover_open' as const, id: '1234567890abcdef', text: '来啦坐吧',
  sha256: hash(wav), bytes: wav.length, duration_ms: 1000, format: 'wav' as const };
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
store.writeAudio(acc, item.id, wav, 'wav');
store.insertItem(acc, item);
const original = store.getItem(acc, item.id);
// RED: 旧 INSERT OR REPLACE 会把 cover_open 条目移到 presence_return，且不会抛错。
assert.throws(() => store.insertItem(acc, { ...item, slot: 'greeting.presence_return' }), code('clip_identity_conflict'));
assert.deepEqual(store.getItem(acc, item.id), original);
store.insertItem(acc, item);
assert.deepEqual(store.getItem(acc, item.id), original);
assert.throws(() => store.writeAudio(acc, item.id, pcmToWav(Buffer.alloc(48000, 1)), 'wav'), code('clip_identity_conflict'));
assert.deepEqual(store.readAudio(acc, item.id, 'wav'), wav);

const keep = REQUIRED_SLOTS.flatMap(slot => [0, 1].map(n => {
  const id = hash(`${slot}:${n}`).slice(0, 16);
  store.writeAudio(acc, id, wav, 'wav');
  store.insertItem(acc, { ...item, slot, id, text: `短句${n}` });
  return { slot, id };
}));
assert.equal(store.commitSet(acc, keep, gen, { expectedRevision: 0 }), 1);
const snapshot = () => JSON.stringify({ state: store.getState(acc), active: store.listActive(acc) });
let before = snapshot();
const rejectsUnchanged = (candidate: typeof keep, expected: string) => {
  assert.throws(() => store.commitSet(acc, candidate, gen, { expectedRevision: 1 }), code(expected));
  assert.equal(snapshot(), before);
};
rejectsUnchanged(keep.slice(1), 'invalid_slot_count');
rejectsUnchanged([{ ...keep[0], slot: 'farewell.night' }, ...keep.slice(1)], 'clip_slot_mismatch');
rejectsUnchanged([...keep, keep[0]], 'duplicate_clip_id');
const p = store.audioPath(acc, keep[0].id, 'wav');
unlinkSync(p);
rejectsUnchanged(keep, 'clip_file_missing');
writeFileSync(p, wav);
writeFileSync(p, pcmToWav(Buffer.alloc(48000, 2)));
rejectsUnchanged(keep, 'clip_file_mismatch');
writeFileSync(p, wav);

const fixedId = 'aaaabbbbccccdddd';
store.writeAudio(acc, fixedId, wav, 'wav');
store.insertItem(acc, { ...item, id: fixedId, slot: 'device_reply.already' });
const next = [...keep, { slot: 'device_reply.already' as const, id: fixedId }];
assert.equal(store.commitSet(acc, next, gen, { expectedRevision: 1 }), 2);
before = snapshot();
assert.throws(() => store.commitSet(acc, keep, gen, { expectedRevision: 1 }), code('revision_conflict'));
assert.equal(snapshot(), before);
const manifest = store.buildManifest(acc);
assert.equal(store.commitSet(acc, [...next].reverse(), gen, { expectedRevision: 2 }), null);
assert.deepEqual(store.buildManifest(acc).slots, manifest.slots);
assert.equal(store.getState(acc).revision, 2);

process.env.LOCAL_AUDIO_WRITES_PAUSED = '1';
for (const action of [() => store.writeAudio(acc, item.id, wav, 'wav'), () => store.insertItem(acc, item),
  () => store.commitSet(acc, next, gen, { expectedRevision: 2 }), () => store.cleanup(acc), () => store.clearAccount(acc)]) {
  assert.throws(action, code('local_audio_writes_paused'));
}
assert.equal(store.buildManifest(acc).revision, 2);
assert.deepEqual(readFileSync(p), wav);
store.recordFetch(acc, null, 2);
assert.equal(store.getState(acc).last_applied_revision, 0);
const { runLocalAudioForAccount } = await import('../src/local-audio-generator.js');
const paused = await runLocalAudioForAccount(acc, { force: true });
assert.equal(paused.skipped, 'writes_paused');
const { buildSlot } = await import('../src/local-audio-generator.js');
const { stageDeviceReplyClips } = await import('../src/local-audio-device-reply.js');
const { stageG1SettingsClips, resolveG1SettingsClips } = await import('../src/local-audio-g1-settings.js');
await assert.rejects(() => buildSlot(acc, 'greeting.normal', undefined, 2, true), code('local_audio_writes_paused'));
await assert.rejects(() => stageDeviceReplyClips(acc), code('local_audio_writes_paused'));
await assert.rejects(() => resolveG1SettingsClips([acc], { synthesize: async () => { throw Error('must not synthesize'); } }), code('local_audio_writes_paused'));
assert.throws(() => stageG1SettingsClips([acc], {}), code('local_audio_writes_paused'));
process.env.LOCAL_AUDIO_WRITES_PAUSED = '0';
// 内容恢复必须前进 revision；真实回报和其它业务表不由恢复伪造。
assert.equal(store.commitSet(acc, keep, gen, { expectedRevision: 2 }), 3);
assert.equal(store.getState(acc).last_applied_revision, 0);
console.log('local-audio-integrity: immutable staging / real publication / CAS / maintenance / forward recovery PASS');

// 仅内存 HTTP 请求 + 临时 SQLite，绝不发送到公网或伪造生产 applied。
const sn = 'BJP00326060100009991', otherSn = 'BJP00326060100009992', httpAcc = `device-${sn}`;
process.env.AUTH_JWT_SECRET = 'local-audio-test-secret-only';
process.env.DEVICE_SN_ALLOW = `${sn},${otherSn}`;
process.env.PERSONA_LOCAL_AUDIO_ENABLED = '1';
process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST = '';
for (const k of keep) {
  const it = store.getItem(acc, k.id)!;
  store.writeAudio(httpAcc, it.id, wav, 'wav'); store.insertItem(httpAcc, it);
}
store.commitSet(httpAcc, keep, gen, { expectedRevision: 0 });
process.env.LOCAL_AUDIO_WRITES_PAUSED = '1';
const { localAudioDeviceRoute } = await import('../src/routes/local-audio.js');
const { SignJWT } = await import('jose');
const tokenFor = (sub: string) => new SignJWT({ kind: 'p003-device' }).setSubject(sub)
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const auth = { authorization: `Bearer ${await tokenFor(sn)}` };
assert.equal((await localAudioDeviceRoute.request('/manifest')).status, 401);
assert.equal((await localAudioDeviceRoute.request('/manifest', { headers: auth })).status, 200);
const file = await localAudioDeviceRoute.request(`/file/${keep[0].id}`, { headers: auth });
assert.equal(file.status, 200);
assert.equal(file.headers.get('etag'), `"${hash(wav)}"`);
assert.equal(hash(Buffer.from(await file.arrayBuffer())), hash(wav));
assert.equal((await localAudioDeviceRoute.request(`/file/${keep[0].id}`, { headers: { ...auth, 'if-none-match': `"${hash(wav)}"` } })).status, 304);
assert.equal((await localAudioDeviceRoute.request(`/file/${keep[0].id}`, { headers: { authorization: `Bearer ${await tokenFor(otherSn)}` } })).status, 404);
assert.equal((await localAudioDeviceRoute.request('/file/ffffffffffffffff', { headers: auth })).status, 404);
assert.equal(store.getState(httpAcc).last_applied_revision, 0);
console.log('local-audio-integrity: HTTP auth / owner / legacy ID / SHA / ETag / read during maintenance PASS');
