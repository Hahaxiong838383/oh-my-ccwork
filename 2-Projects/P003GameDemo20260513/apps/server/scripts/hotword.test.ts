/**
 * Worker 热词管理单测（P0，2026-08-18）。
 * 跑法：cd apps/server && npx tsx scripts/hotword.test.ts
 * 通道走 HOTWORD_CHANNEL_MOCK 注入（不真连 64.90）；DB 用临时文件。
 * 负向锚纪律：黑名单必须真的拒、未确认退出词必须真的拦、对撞失败必须真的 502——
 * 每条防线都有一个「注入坏输入看它变红」的测试。
 */
import assert from 'node:assert';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'hotword-test-'));
process.env.DEVICES_DB_PATH = path.join(tmp, 'devices.db');
process.env.STUDIO_USER = 'admin-t';
process.env.STUDIO_PASS = 'pass-t';
process.env.STUDIO_EDITOR_USERS = 'editor-t';
process.env.STUDIO_EDITOR_PASS = 'editor-pass-t';
// 安全窗口分支要可判定：生产机 shell 带 .env.local 的 LIVEKIT_* 时会真查房间数，「不可达→409」会变 502 —— 显式清掉
for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) delete process.env[k];
// 通道 mock：status/fillers/apply 各给一份可控回执
const LIVE = {
  INTERRUPT_HOTWORDS: '停,停止',
  VOLC_ASR_HOTWORDS: '停,停止,继续,再见',
  EXIT_SWALLOW_HOTWORDS: '再见,拜拜',
};
process.env.HOTWORD_CHANNEL_MOCK = JSON.stringify({
  status: { ok: true, env: LIVE, proc: LIVE, poc_env: { VOLC_ASR_HOTWORDS: '旧值漂移' }, unit_active: true, recent_activity: 0 },
  fillers: { ok: true, manifest: { 'greet_01.wav': { bucket: 'greet', text: '哎，你好呀。' }, 'barge_01.wav': { bucket: 'barge', text: '好。' } } },
  apply: { ok: true, applied: [], proc: LIVE },
});

const { hotwordStore, validateWords, subsetWarnings } = await import('../src/hotword-store.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);
async function login(username: string, password: string): Promise<string> {
  const r = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return ((await r.json()) as { token: string }).token;
}
const adminToken = await login('admin-t', 'pass-t');
const editorToken = await login('editor-t', 'editor-pass-t');
if (!adminToken || !editorToken) throw new Error('登录失败，无法继续');
const H = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}

// ── 校验规则 ──
await t('语气词黑名单拒入 ASR 表(负向锚)', () => {
  const r = validateWords('asr', ['停', '嗯']);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /语气词/);
});
await t('同词在打断表不受黑名单限制', () => {
  assert.equal(validateWords('interrupt', ['嗯', '停']).ok, true);
});
await t('非法字符被拒(负向锚)', () => {
  const r = validateWords('interrupt', ['停;rm -rf']);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /非法字符/);
});
await t('换行注入被拒(env 防线)', () => {
  assert.equal(validateWords('interrupt', ['停\nVAD_MODEL_PATH=x']).ok, false);
});
await t('去重与空白清理', () => {
  const r = validateWords('exit', [' 再见 ', '再见', '拜拜']);
  assert.equal(r.ok, true);
  assert.deepEqual((r as { words: string[] }).words, ['再见', '拜拜']);
});
await t('空表被拒', () => {
  assert.equal(validateWords('exit', ['  ']).ok, false);
});
await t('子集警告:短打断词缺席 ASR 表时报警(正锚)', () => {
  const w = subsetWarnings({ interrupt: ['停', '闭嘴'], asr: ['停'], exit: [] });
  assert.equal(w.length, 1);
  assert.match(w[0]!, /闭嘴/);
});
await t('子集警告:全覆盖时零警告', () => {
  assert.equal(subsetWarnings({ interrupt: ['停'], asr: ['停', '再见'], exit: ['再见'] }).length, 0);
});

await t('device_asr kind:黑名单同适用+草稿可存(CHECK 迁移生效)', () => {
  const bad = validateWords('device_asr', ['读写台', '嗯']);
  assert.equal(bad.ok, false, '语气词进 device_asr 也必须拒');
  hotwordStore.saveDraft('device_asr', ['读写台', '虚像'], 'cc');
  assert.deepEqual(hotwordStore.draftOf('device_asr')?.words, ['读写台', '虚像']);
  hotwordStore.deleteDraft('device_asr');
});

// ── store 版本模型 ──
await t('draft upsert 每 kind 唯一', () => {
  hotwordStore.saveDraft('interrupt', ['停'], 'cc');
  hotwordStore.saveDraft('interrupt', ['停', '闭嘴'], 'cc');
  const d = hotwordStore.draftOf('interrupt');
  assert.deepEqual(d?.words, ['停', '闭嘴']);
});
await t('publish 版本递增+旧版 archived', () => {
  const v1 = hotwordStore.markPublished('interrupt', ['停'], 'cc');
  assert.equal(v1.version, 1);
  const v2 = hotwordStore.markPublished('interrupt', ['停', '安静'], 'cc');
  assert.equal(v2.version, 2);
  const hist = hotwordStore.history('interrupt');
  assert.equal(hist.length, 2);
  assert.equal(hist[0]!.status, 'published');
  assert.equal(hist[1]!.status, 'archived');
  assert.equal(hotwordStore.draftOf('interrupt'), null); // publish 清 draft
});
await t('versionOf 能取到历史版本', () => {
  assert.deepEqual(hotwordStore.versionOf('interrupt', 1)?.words, ['停']);
});

// ── API 层 ──
await t('无鉴权 401', async () => {
  const r = await app.request('/api/admin/hotwords');
  assert.equal(r.status, 401);
});
await t('editor 角色 403(admin 专属门控)', async () => {
  const r = await app.request('/api/admin/hotwords', { headers: H(editorToken) });
  assert.equal(r.status, 403);
});
await t('GET /hotwords 汇总:live 值+同步态+poc 漂移检出', async () => {
  const r = await app.request('/api/admin/hotwords', { headers: H(adminToken) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.channel_ok, true);
  assert.deepEqual(j.kinds.interrupt.live, ['停', '停止']);
  assert.equal(j.kinds.asr.live_in_sync, true);
  assert.equal(j.poc_drifted, true); // mock 里 poc 值≠rust 值
});
await t('PUT draft 校验生效(黑名单进 API 也拦)', async () => {
  const r = await app.request('/api/admin/hotwords/asr/draft', {
    method: 'PUT', headers: H(adminToken), body: JSON.stringify({ words: ['停', '嗯'] }),
  });
  assert.equal(r.status, 400);
});
await t('publish 无草稿报 400', async () => {
  const r = await app.request('/api/admin/hotwords/publish', {
    method: 'POST', headers: H(adminToken), body: JSON.stringify({ kinds: ['asr'] }),
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /无草稿/);
});
await t('退出词未确认必拦(负向锚:跨端合同门)', async () => {
  await app.request('/api/admin/hotwords/exit/draft', {
    method: 'PUT', headers: H(adminToken), body: JSON.stringify({ words: ['再见'] }),
  });
  const r = await app.request('/api/admin/hotwords/publish', {
    method: 'POST', headers: H(adminToken), body: JSON.stringify({ kinds: ['exit'] }),
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /codex/);
});
await t('安全窗口:LiveKit 不可达时 409(fail-closed)', async () => {
  // 测试环境无 LIVEKIT_* env → fetchLiveKitRooms 返回 null → 409
  const r = await app.request('/api/admin/hotwords/publish', {
    method: 'POST', headers: H(adminToken), body: JSON.stringify({ kinds: ['exit'], exit_confirmed: true }),
  });
  assert.equal(r.status, 409);
});
await t('force 发布走通道:成功但对撞失败必 502(负向锚)', async () => {
  // mock apply 回执 proc=LIVE(exit=再见,拜拜)，草稿是 [再见] → 对撞必失败
  const r = await app.request('/api/admin/hotwords/publish', {
    method: 'POST', headers: H(adminToken), body: JSON.stringify({ kinds: ['exit'], exit_confirmed: true, force: true }),
  });
  assert.equal(r.status, 502);
  assert.match(((await r.json()) as { error: string }).error, /对撞失败/);
});
await t('force 发布:对撞一致 → 落版本', async () => {
  // 草稿改成与 mock proc 完全一致 → 对撞过 → published v1
  await app.request('/api/admin/hotwords/exit/draft', {
    method: 'PUT', headers: H(adminToken), body: JSON.stringify({ words: ['再见', '拜拜'] }),
  });
  const r = await app.request('/api/admin/hotwords/publish', {
    method: 'POST', headers: H(adminToken), body: JSON.stringify({ kinds: ['exit'], exit_confirmed: true, force: true }),
  });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.versions.exit, 1);
  assert.equal(hotwordStore.publishedOf('exit')?.words.join(','), '再见,拜拜');
});
await t('rollback-draft 取历史版本为草稿', async () => {
  const r = await app.request('/api/admin/hotwords/rollback-draft', {
    method: 'POST', headers: H(adminToken), body: JSON.stringify({ kind: 'interrupt', version: 1 }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(hotwordStore.draftOf('interrupt')?.words, ['停']);
});
await t('fillers 只读按桶分组', async () => {
  const r = await app.request('/api/admin/hotwords/fillers', { headers: H(adminToken) });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.buckets.greet[0].text, '哎，你好呀。');
  assert.equal(j.buckets.barge.length, 1);
});

hotwordStore.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
