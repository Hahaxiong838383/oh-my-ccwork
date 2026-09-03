/**
 * Worker 语音链路配置后台回归（2026-09-03）· 跑法：NODE_OPTIONS=--experimental-sqlite tsx scripts/worker-voice.test.ts
 * 通道走 HOTWORD_CHANNEL_MOCK（不真连 64.90）；覆盖：校验白名单/正则/范围/注入、空密钥=不改、admin 门（editor 403）、
 * GET 密钥只回 hint/len、字段表下发、PUT 安全窗口 409 / force 对撞通过 / 对撞失败 502 / 坏值 400。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
process.env.DEVICES_DB_PATH = path.join(tmp, 'devices.db');
process.env.PROFILE_DB_PATH = path.join(tmp, 'profile.db');
process.env.ACCOUNTS_DB_PATH = path.join(tmp, 'accounts.db');
process.env.STUDIO_USER = 'admin-t';
process.env.STUDIO_PASS = 'pass-t';
process.env.STUDIO_EDITOR_USERS = 'editor-t';
process.env.STUDIO_EDITOR_PASS = 'editor-pass-t';
process.env.AUTH_JWT_SECRET = 'test-secret';
// 安全窗口分支要可判定：生产机跑测试时 shell 里带着 .env.local 的 LIVEKIT_*，会真去查房间数把 409 变 200 —— 显式清掉
for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete process.env[k];
const KEY32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const LIVE = {
  VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration', VOLC_ASR_END_WINDOW_MS: '150', VOLC_ASR_ENABLE_DDC: '1',
  VOLC_ASR_NONSTREAM_ENABLED: '1', VOLC_ASR_NONSTREAM_CANARY_SN: '', TTS_PROVIDER: 'xfyun', XFYUN_TTS_VCN: 'x6_lingxiaoxuan_pro',
  VOLC_ASR_API_KEY: { set: true, hint: 'abcd…kl', len: 36 }, XFYUN_TTS_API_KEY: { set: true, hint: 'a1b2…d6', len: 32 },
};
process.env.HOTWORD_CHANNEL_MOCK = JSON.stringify({
  voice_get: { ok: true, rust: { TTS_PROVIDER: 'xfyun', XFYUN_TTS_VCN: 'x6_lingxiaoxuan_pro', XFYUN_TTS_API_KEY: LIVE.XFYUN_TTS_API_KEY }, base: { VOLC_ASR_RESOURCE_ID: 'volc.seedasr.sauc.duration', VOLC_ASR_API_KEY: LIVE.VOLC_ASR_API_KEY }, proc: LIVE, unit_active: true, main_pid: 1, recent_activity: 0 },
  voice_set: { ok: true, applied: ['VOLC_ASR_END_WINDOW_MS', 'TTS_PROVIDER', 'XFYUN_TTS_API_KEY'], backup: '/root/x.bak', proc: { ...LIVE, VOLC_ASR_END_WINDOW_MS: '200', TTS_PROVIDER: 'xfyun', XFYUN_TTS_API_KEY: { set: true, hint: 'a1b2…d6', len: 32 } } },
});

const { Hono } = await import('hono');
const { adminDataRoute, validateVoiceValues, VOICE_FIELDS, VOICE_RW_KEYS, VOICE_SECRET_KEYS } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);
async function login(username: string, password: string): Promise<string> {
  const r = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return ((await r.json()) as { token: string }).token;
}
const adminToken = await login('admin-t', 'pass-t');
const editorToken = await login('editor-t', 'editor-pass-t');
if (!adminToken || !editorToken) throw new Error('登录失败');
const H = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass++; } catch (e) { fail++; console.log(`  FAIL ${name}: ${(e as Error).message}`); }
}

await t('字段表覆盖全部白名单键且每键唯一', () => {
  const keys = VOICE_FIELDS.map((f) => f.key);
  assert.deepEqual([...keys].sort(), [...VOICE_RW_KEYS].sort());
  assert.equal(new Set(keys).size, keys.length);
  for (const k of VOICE_SECRET_KEYS) assert.equal(VOICE_FIELDS.find((f) => f.key === k)?.type, 'secret', k);
});
await t('校验：白名单外键拒（LiveKit 密钥不可经此改）', () => assert.equal(validateVoiceValues({ LIVEKIT_API_SECRET: 'x' }).ok, false));
await t('校验：TTS_PROVIDER 只认 volc/xfyun', () => {
  assert.equal(validateVoiceValues({ TTS_PROVIDER: 'azure' }).ok, false);
  assert.equal(validateVoiceValues({ TTS_PROVIDER: 'volc' }).ok, true);
});
await t('校验：判停窗范围 100~2000', () => {
  assert.equal(validateVoiceValues({ VOLC_ASR_END_WINDOW_MS: '50' }).ok, false);
  assert.equal(validateVoiceValues({ VOLC_ASR_END_WINDOW_MS: '2001' }).ok, false);
  assert.equal(validateVoiceValues({ VOLC_ASR_END_WINDOW_MS: '150' }).ok, true);
});
await t('校验：env 注入（换行/分号/引号）拒', () => {
  assert.equal(validateVoiceValues({ VOLC_ASR_END_WINDOW_MS: '150\nEVIL=1' }).ok, false);
  assert.equal(validateVoiceValues({ VOLC_ASR_RESOURCE_ID: 'volc.x; rm -rf /' }).ok, false);
  assert.equal(validateVoiceValues({ XFYUN_TTS_VCN: 'x"y' }).ok, false);
});
await t('校验：灰度 SN 空=全开合法；含空格拒', () => {
  assert.equal(validateVoiceValues({ VOLC_ASR_NONSTREAM_CANARY_SN: '' }).ok, true);
  assert.equal(validateVoiceValues({ VOLC_ASR_NONSTREAM_CANARY_SN: 'bjp00326060100200003,bjp00326060100200098' }).ok, true);
  assert.equal(validateVoiceValues({ VOLC_ASR_NONSTREAM_CANARY_SN: 'a b' }).ok, false);
});
await t('校验：语速范围（火山 0.5~2.0 / 讯飞 0~100）', () => {
  assert.equal(validateVoiceValues({ VOLC_TTS_SPEED: '3.0' }).ok, false);
  assert.equal(validateVoiceValues({ VOLC_TTS_SPEED: '1.2' }).ok, true);
  assert.equal(validateVoiceValues({ XFYUN_TTS_SPEED: '101' }).ok, false);
});
await t('校验：空密钥=不改；全空=没有可写的值', () => {
  const r = validateVoiceValues({ XFYUN_TTS_API_KEY: '', TTS_PROVIDER: 'xfyun' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys((r as { values: object }).values), ['TTS_PROVIDER']);
  assert.equal(validateVoiceValues({ XFYUN_TTS_API_KEY: '', VOLC_ASR_API_KEY: '' }).ok, false);
});
await t('GET /worker-voice：editor 403、admin 200、密钥只回 hint/len、字段表下发', async () => {
  assert.equal((await app.request('/api/admin/worker-voice', { headers: H(editorToken) })).status, 403);
  const r = await app.request('/api/admin/worker-voice', { headers: H(adminToken) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.equal(j.worker.proc.TTS_PROVIDER, 'xfyun');
  assert.equal(j.worker.proc.XFYUN_TTS_API_KEY.set, true);
  assert.equal(JSON.stringify(j).includes(KEY32), false, '整串密钥不得出现');
  assert.ok(Array.isArray(j.fields) && j.fields.length === VOICE_RW_KEYS.length);
  assert.deepEqual(j.secret_keys, VOICE_SECRET_KEYS);
});
await t('PUT：无 LIVEKIT env → 安全窗口 409；force 绕过并对撞通过（密钥比长度）', async () => {
  const body = { values: { VOLC_ASR_END_WINDOW_MS: '200', TTS_PROVIDER: 'xfyun', XFYUN_TTS_API_KEY: KEY32 } };
  const r1 = await app.request('/api/admin/worker-voice', { method: 'PUT', headers: H(adminToken), body: JSON.stringify(body) });
  assert.equal(r1.status, 409);
  const r2 = await app.request('/api/admin/worker-voice', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ ...body, force: true }) });
  const j = (await r2.json()) as any;
  assert.equal(r2.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true); assert.equal(j.proc.VOLC_ASR_END_WINDOW_MS, '200');
  assert.equal(JSON.stringify(j).includes(KEY32), false, '回执不得含整串密钥');
});
await t('PUT：对撞失败 502（进程值≠期望 / 密钥长度不符）', async () => {
  const r = await app.request('/api/admin/worker-voice', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ force: true, values: { VOLC_ASR_END_WINDOW_MS: '300' } }) });
  assert.equal(r.status, 502);
  const r2 = await app.request('/api/admin/worker-voice', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ force: true, values: { XFYUN_TTS_API_KEY: 'a1b2c3d4e5f6a7b8c9d0' } }) });
  assert.equal(r2.status, 502);
});
await t('PUT：坏值 400、editor 403', async () => {
  assert.equal((await app.request('/api/admin/worker-voice', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ force: true, values: { TTS_PROVIDER: 'x;rm' } }) })).status, 400);
  assert.equal((await app.request('/api/admin/worker-voice', { method: 'PUT', headers: H(editorToken), body: JSON.stringify({ force: true, values: { TTS_PROVIDER: 'volc' } }) })).status, 403);
});

console.log(`\nworker-voice tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
