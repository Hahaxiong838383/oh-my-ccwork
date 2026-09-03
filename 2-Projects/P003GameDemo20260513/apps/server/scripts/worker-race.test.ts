/**
 * Worker 赛马配置后台回归（2026-09-03）· 跑法：NODE_OPTIONS=--experimental-sqlite tsx scripts/worker-race.test.ts
 * 通道走 HOTWORD_CHANNEL_MOCK（不真连 64.90）；覆盖：admin 门/校验白名单/密钥不回显/安全窗口 409/对撞/bench 参数门/设备真 prompt。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'race-test-'));
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
process.env.LLM_PROVIDER = 'race';
process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash';
process.env.VOLC_LLM_MODEL = 'doubao-seed-2.0-lite';
const LIVE = {
  LLM_BASE_URL: 'https://kidshub-ai.hahaxiong.cc/v1', LLM_MODEL: 'xiaoke-device', LLM_THINKING: 'off',
  LLM_FALLBACK_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan/v3', LLM_FALLBACK_MODEL: 'doubao-seed-2.0-mini',
  LLM_FALLBACK_THINKING: 'disabled', LLM_FALLBACK_API_KEY: { set: true, hint: 'ark-XXXX…', len: 46 },
  LLM_RACE_MAIN_GRACE_MS: '800', AGENT_INSTRUCTIONS: '你叫小可',
};
process.env.HOTWORD_CHANNEL_MOCK = JSON.stringify({
  race_get: { ok: true, file: LIVE, proc: LIVE, unit_active: true, main_pid: 1, recent_activity: 0 },
  race_stats: { ok: true, hours: 48, n: 10, won_main: 9, won_fallback: 1, p50: 800, p90: 1200, p95: 1300, max: 2000, fallback_won_ttft: [900] },
  race_set: { ok: true, applied: ['LLM_FALLBACK_MODEL', 'LLM_RACE_MAIN_GRACE_MS', 'LLM_FALLBACK_API_KEY'], backup: '/root/x.bak', proc: { ...LIVE, LLM_FALLBACK_MODEL: 'deepseek-v4-flash', LLM_RACE_MAIN_GRACE_MS: '600', LLM_FALLBACK_API_KEY: { set: true, hint: 'ark-YYYY…', len: 24 } } },
  race_bench: { ok: true, base: LIVE.LLM_FALLBACK_BASE_URL, runs: 1, system_chars: 5, rows: [{ status: 200, ttft_ms: 600, total_ms: 900, chars: 20, model: 'doubao-seed-2.0-mini', user: '太亮了', run: 1 }], truncated: false },
});

const { Hono } = await import('hono');
const { adminDataRoute, validateRaceValues, RACE_MODEL_CATALOG } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');

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

await t('校验：白名单外键拒', () => { const r = validateRaceValues({ P003_DEVICE_INTENT_EXECUTE: '1' }); assert.equal(r.ok, false); });
await t('校验：URL 非 https 拒', () => assert.equal(validateRaceValues({ LLM_FALLBACK_BASE_URL: 'http://x/y' }).ok, false));
await t('校验：grace 越界拒', () => assert.equal(validateRaceValues({ LLM_RACE_MAIN_GRACE_MS: '100' }).ok, false));
await t('校验：instructions 含换行/引号/$ 拒', () => {
  assert.equal(validateRaceValues({ AGENT_INSTRUCTIONS: 'a\nb' }).ok, false);
  assert.equal(validateRaceValues({ AGENT_INSTRUCTIONS: 'a"b' }).ok, false);
  assert.equal(validateRaceValues({ AGENT_INSTRUCTIONS: 'a$b' }).ok, false);
});
await t('校验：空 key=不改；合法值通过', () => {
  const r = validateRaceValues({ LLM_FALLBACK_API_KEY: '', LLM_FALLBACK_MODEL: 'doubao-seed-2.0-mini', AGENT_INSTRUCTIONS: '你叫小可，[[DEV:6]]→调暗' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys((r as { values: object }).values).sort(), ['AGENT_INSTRUCTIONS', 'LLM_FALLBACK_MODEL']);
});
await t('目录含推荐 mini 且 glm 标 unsupported', () => {
  assert.equal(RACE_MODEL_CATALOG.find((m) => m.model === 'doubao-seed-2.0-mini')?.tier, 'recommended');
  assert.equal(RACE_MODEL_CATALOG.find((m) => m.model === 'glm-5.3')?.tier, 'unsupported');
});
await t('GET /worker-race：editor 403、admin 200 且密钥不回显', async () => {
  assert.equal((await app.request('/api/admin/worker-race', { headers: H(editorToken) })).status, 403);
  const r = await app.request('/api/admin/worker-race', { headers: H(adminToken) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.equal(j.worker.file.LLM_FALLBACK_MODEL, 'doubao-seed-2.0-mini');
  assert.equal(j.worker.file.LLM_FALLBACK_API_KEY.set, true);
  assert.equal(JSON.stringify(j).includes('ark-XXXX…'), true, 'hint 可见');
  assert.equal(j.brain.provider, 'race');
  assert.ok(Array.isArray(j.presets) && j.presets.length === 2 && Array.isArray(j.catalog));
});
await t('GET /worker-race/stats 透传', async () => {
  const j = (await (await app.request('/api/admin/worker-race/stats?hours=48', { headers: H(adminToken) })).json()) as any;
  assert.equal(j.won_main, 9); assert.equal(j.p50, 800);
});
await t('PUT：无 LIVEKIT env → 安全窗口 409；force 绕过并对撞通过', async () => {
  const body = { values: { LLM_FALLBACK_MODEL: 'deepseek-v4-flash', LLM_RACE_MAIN_GRACE_MS: '600', LLM_FALLBACK_API_KEY: 'ark-YYYYYYYYYYYYYYYYYYYY' } };
  const r1 = await app.request('/api/admin/worker-race', { method: 'PUT', headers: H(adminToken), body: JSON.stringify(body) });
  assert.equal(r1.status, 409);
  const r2 = await app.request('/api/admin/worker-race', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ ...body, force: true }) });
  const j = (await r2.json()) as any;
  assert.equal(r2.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true); assert.equal(j.proc.LLM_FALLBACK_MODEL, 'deepseek-v4-flash');
});
await t('PUT：对撞失败 502（进程值≠期望）', async () => {
  const r = await app.request('/api/admin/worker-race', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ force: true, values: { LLM_FALLBACK_MODEL: 'minimax-m3' } }) });
  assert.equal(r.status, 502);
});
await t('PUT：坏值 400', async () => {
  const r = await app.request('/api/admin/worker-race', { method: 'PUT', headers: H(adminToken), body: JSON.stringify({ force: true, values: { LLM_FALLBACK_MODEL: 'x;rm -rf' } }) });
  assert.equal(r.status, 400);
});
await t('bench：参数门 + short 透传', async () => {
  assert.equal((await app.request('/api/admin/worker-race/bench', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ models: [] }) })).status, 400);
  const r = await app.request('/api/admin/worker-race/bench', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ models: ['doubao-seed-2.0-mini'], runs: 1 }) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.equal(j.rows[0].ttft_ms, 600); assert.equal(j.prompt, 'short');
});
await t('bench：device 真 prompt 需台账设备', async () => {
  const r = await app.request('/api/admin/worker-race/bench', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ models: ['doubao-seed-2.0-mini'], prompt: 'device', sn: 'BJP00326060100000000' }) });
  assert.equal(r.status, 400);
  deviceRegistryStore.add('BJP00326060100000123', '测试机');
  const r2 = await app.request('/api/admin/worker-race/bench', { method: 'POST', headers: H(adminToken), body: JSON.stringify({ models: ['doubao-seed-2.0-mini'], prompt: 'device', sn: 'BJP00326060100000123' }) });
  // 未开通 brain（无 account_id）→ 400；有账号时走 buildDeviceLayers（由 mock 通道回执）
  assert.equal(r2.status, 400);
});

console.log(`\nworker-race tests: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
