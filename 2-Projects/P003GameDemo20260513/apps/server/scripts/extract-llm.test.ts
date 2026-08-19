/**
 * 记忆抽取 LLM 配置单测：DB 优先/inherit 回落/key 保留语义/写后热生效/掩码/admin 门控。
 * 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite npx tsx scripts/extract-llm.test.ts
 * 隔离：devices 库指向临时路径；不发真实 LLM 请求（test 端点仅验路由与门控时用假 URL 快速失败）。
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';

const TMP = '/private/tmp/claude-501/-Users-rayman-chen-mycc/410a354a-ee50-4c8b-9b06-02a639743e97/scratchpad';
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${TMP}/exllm-devices.db${suffix}`);
  } catch {
    /* 不存在即干净 */
  }
}
process.env.DEVICES_DB_PATH = `${TMP}/exllm-devices.db`;
process.env.STUDIO_USER = 'test-admin';
process.env.STUDIO_PASS = 'test-pass';
process.env.LLM_PROVIDER = 'race';
process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-key-0000';
delete process.env.DEEPSEEK_BASE_URL;
delete process.env.DEEPSEEK_MODEL;

const { extractLlmStore } = await import('../src/extract-llm-store.js');
const { resolveExtractLlm } = await import('../src/llm-extract.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);

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

const adminToken = (
  (await (
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-pass' }),
    })
  ).json()) as { token: string }
).token;
const guestToken = (
  (await (
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'guest', password: '123456' }),
    })
  ).json()) as { token: string }
).token;
assert.ok(adminToken && guestToken, '登录失败');

async function req(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

await t('T1 无配置 → 跟随 env：race 映射 deepseek（主路同源）', () => {
  const r = resolveExtractLlm();
  assert.equal(r.source, 'env');
  assert.equal(r.provider, 'deepseek');
  assert.equal(r.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(r.apiKey, 'sk-test-deepseek-key-0000');
});

await t('T2 保存 admin 配置 → 立即生效（热生效，不重启）', async () => {
  const res = await req(adminToken, 'PUT', '/extract-llm', {
    provider: 'volc-ark',
    base_url: 'https://ark.example.com/v3',
    model: 'doubao-test',
    api_key: 'ak-volc-test-1234',
  });
  assert.equal(res.status, 200);
  const r = resolveExtractLlm();
  assert.equal(r.source, 'admin');
  assert.equal(r.provider, 'volc-ark');
  assert.equal(r.baseUrl, 'https://ark.example.com/v3');
  assert.equal(r.model, 'doubao-test');
  assert.equal(r.apiKey, 'ak-volc-test-1234');
});

await t('T3 GET 掩码：key 只回尾 4 位，永不回原文', async () => {
  const data = (await (await req(adminToken, 'GET', '/extract-llm')).json()) as {
    config: { api_key_masked: string };
    live: { api_key_masked: string; source: string };
  };
  assert.equal(data.config.api_key_masked, '****1234');
  assert.equal(data.live.api_key_masked, '****1234');
  assert.equal(data.live.source, 'admin');
  assert.ok(!JSON.stringify(data).includes('ak-volc-test-1234'), '响应泄露了 key 原文');
});

await t('T4 PUT 不传 api_key = 保留旧 key（前端不回显不重传）', async () => {
  await req(adminToken, 'PUT', '/extract-llm', { provider: 'volc-ark', base_url: '', model: 'doubao-v2' });
  const r = resolveExtractLlm();
  assert.equal(r.apiKey, 'ak-volc-test-1234', '未传 key 应保留');
  assert.equal(r.model, 'doubao-v2');
  assert.equal(r.baseUrl, 'https://ark.cn-beijing.volces.com/api/v3', '空 base_url 应回落该 provider 默认');
});

await t('T5 provider=inherit → 回落 env（含显式清 key）', async () => {
  await req(adminToken, 'PUT', '/extract-llm', { provider: 'inherit', base_url: '', model: '', api_key: '' });
  const r = resolveExtractLlm();
  assert.equal(r.source, 'env');
  assert.equal(r.provider, 'deepseek');
});

await t('T6 校验：非法 provider / 非 http base_url 拒绝', async () => {
  assert.equal((await req(adminToken, 'PUT', '/extract-llm', { provider: 'openai' })).status, 400);
  assert.equal((await req(adminToken, 'PUT', '/extract-llm', { provider: 'deepseek', base_url: 'ftp://x' })).status, 400);
});

await t('T7 门控：guest 读写 extract-llm 全 403（admin 专属）', async () => {
  assert.equal((await req(guestToken, 'GET', '/extract-llm')).status, 403);
  assert.equal((await req(guestToken, 'PUT', '/extract-llm', { provider: 'inherit' })).status, 403);
});

await t('T8 test 端点：配置不全时 reachable=false 且不抛（配置层异常不阻断）', async () => {
  extractLlmStore.set({ provider: 'gemini-proxy', base_url: '', model: '', api_key: '' });
  delete process.env.GEMINI_PROXY_URL;
  delete process.env.GEMINI_API_KEY;
  const data = (await (await req(adminToken, 'POST', '/extract-llm/test')).json()) as { ok: boolean; reachable: boolean };
  assert.equal(data.ok, true);
  assert.equal(data.reachable, false);
  extractLlmStore.clear();
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
