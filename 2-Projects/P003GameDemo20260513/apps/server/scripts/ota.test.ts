/**
 * OTA 回归测试 · 跑法：npm run test:ota（tsx 直跑，无框架）
 *
 * 覆盖（联调合同冻结项逐条对应）：
 *  - check 鉴权：无凭据 401 / 凭据 SN≠body SN 403 / 台账外 403 / 限频 429
 *  - 灰度裁决：无 release null / SN 名单命中 / 非名单 null / rollout all 全量 / 多 release 取 max
 *  - 防降级：version_code 相等或更高 → null（server 绝不下发 <=）
 *  - last_result：落库 + error 截断 512B + server_received_ms 双钟 + null 不覆盖旧值
 *  - admin 上传（inspector mock）：包名/证书/versionCode 单调三拒 + 成功入库草稿
 *  - publish：sns 空名单拒 / all 显式全量 / pause / 已发布拒删
 *
 * aapt/apksigner 全程 mock（setApkInspectorForTest），不依赖系统工具。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'ota-test-'));
process.env.OTA_DB_PATH = join(tmp, 'ota.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.OTA_DIR = join(tmp, 'ota-files');
process.env.AUTH_JWT_SECRET = 'test-secret';
process.env.DEVICE_SN_ALLOW = 'BJP00326060100000777';
process.env.OTA_URL_BASE = 'https://kidshub-ai.hahaxiong.cc';
process.env.OTA_CHECK_RPM = '100'; // 功能段放宽（cfg 每请求读 env）；限频专项段单独收紧

const { Hono } = await import('hono');
const { SignJWT } = await import('jose');
const { otaDeviceRoute, otaAdminRoute } = await import('../src/routes/ota.js');
const { otaStore } = await import('../src/ota-store.js');
const { setApkInspectorForTest } = await import('../src/apk-inspect.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}

const app = new Hono();
app.route('/v1/device/ota', otaDeviceRoute);
app.route('/api/admin/ota', otaAdminRoute);

const SECRET = new TextEncoder().encode('test-secret');
async function deviceCred(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device' })
    .setSubject(sn)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET);
}

async function check(sn: string, versionCode: number, cred?: string, extra?: Record<string, unknown>) {
  const res = await app.request('/v1/device/ota/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cred ? { authorization: `Bearer ${cred}` } : {}) },
    body: JSON.stringify({ sn, version_code: versionCode, version_name: 'x', ...extra }),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const SN_DB = 'BJP00326060100000601'; // 台账 active
const SN_ENV = 'BJP00326060100000777'; // 仅 env 白名单
const SN_OUT = 'BJP00326060100000999'; // 都不在
deviceRegistryStore.add(SN_DB, 'ota测试机');

// ---------- 鉴权 ----------
eq('auth-1 无凭据 401', (await check(SN_DB, 62)).status, 401);
{
  const credB = await deviceCred('BJP00326060100000602');
  eq('auth-2 凭据SN≠body 403', (await check(SN_DB, 62, credB)).status, 403);
}
eq('auth-3 台账外 403', (await check(SN_OUT, 62, await deviceCred(SN_OUT))).status, 403);
eq('auth-4 env 白名单放行', (await check(SN_ENV, 62, await deviceCred(SN_ENV))).json.ok, true);

// ---------- 无 release ----------
{
  const r = await check(SN_DB, 62, await deviceCred(SN_DB));
  eq('empty-1 无发布 update:null', { status: r.status, update: r.json.update }, { status: 200, update: null });
}

// ---------- 直接入库两个 release 验证裁决 ----------
otaStore.insertRelease({
  version_code: 63, version_name: '1.2.2-canary.51', package_name: 'com.futurus.p003.launcher',
  apk_path: '/x/63.apk', url_path: '/ota/p003-launcher-63.apk',
  sha256: 'a'.repeat(64), size_bytes: 140000000, cert_sha256: 'c'.repeat(64),
  force_install: 0, install_hint: 'idle_only', notes: 'n63', channel: 'stable', enabled: 0, rollout_sns: '',
});
{
  // 草稿不下发
  const r = await check(SN_DB, 62, await deviceCred(SN_DB));
  eq('gray-1 草稿不下发', r.json.update, null);
  // canary 名单发布：只圈 SN_DB
  otaStore.publish(63, SN_DB, false, 'idle_only');
  const r2 = await check(SN_DB, 62, await deviceCred(SN_DB));
  eq('gray-2 名单命中', r2.json.update?.version_code, 63);
  eq('gray-3 update 字段齐', {
    pkg: r2.json.update.package_name,
    url: r2.json.update.url,
    sha: r2.json.update.sha256.length,
    cert: r2.json.update.cert_sha256,
    force: r2.json.update.force,
    hint: r2.json.update.install_hint,
  }, {
    pkg: 'com.futurus.p003.launcher',
    url: 'https://kidshub-ai.hahaxiong.cc/ota/p003-launcher-63.apk',
    sha: 64,
    cert: 'c'.repeat(64),
    force: false,
    hint: 'idle_only',
  });
  const r3 = await check(SN_ENV, 62, await deviceCred(SN_ENV));
  eq('gray-4 非名单 null', r3.json.update, null);
  // 防降级：等于/大于 都 null
  eq('down-1 等于不下发', (await check(SN_DB, 63, await deviceCred(SN_DB))).json.update, null);
  eq('down-2 更高不下发', (await check(SN_DB, 64, await deviceCred(SN_DB))).json.update, null);
  // 全量
  otaStore.publish(63, '', true, 'immediate');
  const r4 = await check(SN_ENV, 62, await deviceCred(SN_ENV));
  eq('gray-5 rollout all 全量+force', { vc: r4.json.update?.version_code, force: r4.json.update?.force }, { vc: 63, force: true });
}
// 多 release 取 max
otaStore.insertRelease({
  version_code: 64, version_name: '1.2.2-canary.52', package_name: 'com.futurus.p003.launcher',
  apk_path: '/x/64.apk', url_path: '/ota/p003-launcher-64.apk',
  sha256: 'b'.repeat(64), size_bytes: 140000001, cert_sha256: 'c'.repeat(64),
  force_install: 0, install_hint: 'idle_only', notes: '', channel: 'stable', enabled: 1, rollout_sns: '',
});
eq('gray-6 多发布取最大', (await check(SN_DB, 62, await deviceCred(SN_DB))).json.update?.version_code, 64);

// ---------- last_result 落库 ----------
{
  const longErr = 'e'.repeat(600);
  await check(SN_DB, 63, await deviceCred(SN_DB), {
    last_result: { from_version_code: 62, to_version_code: 63, status: 'success', error: longErr, result_ts_ms: 1755677000000 },
  });
  const row = otaStore.listDeviceStatus().find((d) => d.sn === SN_DB)!;
  const lr = JSON.parse(row.last_result_json);
  eq('report-1 版本上报', row.version_code, 63);
  eq('report-2 status', lr.status, 'success');
  eq('report-3 error 截断 512', lr.error.length, 512);
  eq('report-4 双钟', { dev: lr.result_ts_ms, srv: typeof lr.server_received_ms }, { dev: 1755677000000, srv: 'number' });
  // null 不覆盖旧值
  await check(SN_DB, 64, await deviceCred(SN_DB));
  const row2 = otaStore.listDeviceStatus().find((d) => d.sn === SN_DB)!;
  eq('report-5 无 last_result 保留旧值', JSON.parse(row2.last_result_json).status, 'success');
  eq('report-6 版本仍更新', row2.version_code, 64);
}

// ---------- 限频（独立 SN + 临时收紧 RPM=6：第 7 次必 429）----------
{
  const SN_RATE = 'BJP00326060100000888';
  deviceRegistryStore.add(SN_RATE, '限频测试机');
  process.env.OTA_CHECK_RPM = '6';
  const cred = await deviceCred(SN_RATE);
  let last = 0;
  for (let i = 0; i < 8; i += 1) last = (await check(SN_RATE, 62, cred)).status;
  eq('rate-1 风暴 429', last, 429);
  process.env.OTA_CHECK_RPM = '100';
}

// ---------- admin 上传（inspector mock）----------
const GOOD_CERT = '2d370c21f5dfd553d2a796314b70925fb38adeef90864c920bbbbb12887d3522';
let mockFacts = {
  package_name: 'com.futurus.p003.launcher', version_code: 65, version_name: '1.2.2-canary.53',
  cert_sha256: GOOD_CERT, sha256: 'd'.repeat(64), size_bytes: 1234,
};
setApkInspectorForTest(async () => ({ ...mockFacts }));

async function upload(name = 'test.apk') {
  const res = await app.request(`/api/admin/ota/upload?filename=${name}`, {
    method: 'PUT',
    body: new Uint8Array([80, 75, 3, 4]), // 假 zip 头即可（实测被 mock）
  });
  return { status: res.status, json: (await res.json()) as any };
}

{
  mockFacts = { ...mockFacts, package_name: 'com.evil.other' };
  eq('up-1 包名拒', (await upload()).status, 400);
  mockFacts = { ...mockFacts, package_name: 'com.futurus.p003.launcher', cert_sha256: 'f'.repeat(64) };
  eq('up-2 证书拒', (await upload()).status, 400);
  mockFacts = { ...mockFacts, cert_sha256: GOOD_CERT, version_code: 64 };
  eq('up-3 versionCode 不单调拒', (await upload()).json.message?.includes('防降级'), true);
  mockFacts = { ...mockFacts, version_code: 65 };
  const ok = await upload();
  eq('up-4 成功入库草稿', { status: ok.status, enabled: ok.json.release.enabled, vc: ok.json.release.version_code }, { status: 200, enabled: 0, vc: 65 });
  eq('up-5 非 apk 名拒', (await upload('x.zip')).status, 400);
}

// ---------- publish / pause / delete ----------
{
  const emptySns = await app.request('/api/admin/ota/releases/65/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rollout: 'sns', sns: [] }),
  });
  eq('pub-1 sns 空名单拒', emptySns.status, 400);
  const pubAll = await app.request('/api/admin/ota/releases/65/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rollout: 'all' }),
  });
  eq('pub-2 显式 all 发布', pubAll.status, 200);
  eq('pub-3 已发布拒删', (await app.request('/api/admin/ota/releases/65', { method: 'DELETE' })).status, 400);
  eq('pub-4 pause', (await app.request('/api/admin/ota/releases/65/pause', { method: 'POST' })).status, 200);
  eq('pub-5 暂停后可删', (await app.request('/api/admin/ota/releases/65', { method: 'DELETE' })).status, 200);
}

// ---------- 更新说明（2026-09-07 川哥：后台 OTA/版本发布加更新说明；旧坑：publish 收 notes 不落库）----------
{
  const hdr = { 'content-type': 'application/json' };
  mockFacts = { ...mockFacts, version_code: 66 };
  const up = await app.request(`/api/admin/ota/upload?filename=n.apk&notes=${encodeURIComponent(' 上传时写的说明 ')}`, { method: 'PUT', body: new Uint8Array([80, 75, 3, 4]) });
  eq('notes-1 上传可带 notes 落库（去首尾空白）', { s: up.status, n: otaStore.getRelease(66)?.notes }, { s: 200, n: '上传时写的说明' });
  const pub = await app.request('/api/admin/ota/releases/66/publish', { method: 'POST', headers: hdr, body: JSON.stringify({ rollout: 'all', notes: '发布时改的说明：修复 X' }) });
  const pubJ = (await pub.json()) as any;
  eq('notes-2 发布时带 notes 落库（此前被丢）', { s: pub.status, n: pubJ.release?.notes }, { s: 200, n: '发布时改的说明：修复 X' });
  const pub2 = await app.request('/api/admin/ota/releases/66/publish', { method: 'POST', headers: hdr, body: JSON.stringify({ rollout: 'all' }) });
  eq('notes-3 发布不带 notes 不清空', ((await pub2.json()) as any).release?.notes, '发布时改的说明：修复 X');
  const patch = await app.request('/api/admin/ota/releases/66/notes', { method: 'PATCH', headers: hdr, body: JSON.stringify({ notes: '已发布也能改：解决了 Y\n第二行' }) });
  eq('notes-4 已发布版本 PATCH notes 200 且落库', { s: patch.status, n: otaStore.getRelease(66)?.notes }, { s: 200, n: '已发布也能改：解决了 Y\n第二行' });
  eq('notes-5 超 2000 字拒 400', (await app.request('/api/admin/ota/releases/66/notes', { method: 'PATCH', headers: hdr, body: JSON.stringify({ notes: 'x'.repeat(2001) }) })).status, 400);
  eq('notes-6 不存在版本 404', (await app.request('/api/admin/ota/releases/9999/notes', { method: 'PATCH', headers: hdr, body: JSON.stringify({ notes: 'a' }) })).status, 404);
  const list = (await (await app.request('/api/admin/ota/releases')).json()) as any;
  eq('notes-7 列表带 notes', list.releases.find((r: any) => r.version_code === 66)?.notes, '已发布也能改：解决了 Y\n第二行');
  const off = await check(SN_DB, 62, await deviceCred(SN_DB));
  eq('notes-8 设备 offer.notes 带说明（合同字段，此前恒空）', { vc: off.json.update?.version_code, n: off.json.update?.notes }, { vc: 66, n: '已发布也能改：解决了 Y\n第二行' });
  eq('notes-9 清空说明也落库', (await app.request('/api/admin/ota/releases/66/notes', { method: 'PATCH', headers: hdr, body: JSON.stringify({ notes: '' }) })).status === 200 && otaStore.getRelease(66)?.notes === '', true);
}

// ---------- 设备版本分布带台账备注（2026-09-16 川哥：设备接入页人工备注同步到 OTA 页，只读）----------
{
  // SN_DB 台账备注 'ota测试机'；SN_ENV 仅 env 白名单、台账无记录 → note 必须是空串而不是缺字段/null
  await check(SN_DB, 62, await deviceCred(SN_DB));
  await check(SN_ENV, 62, await deviceCred(SN_ENV));
  const devs = ((await (await app.request('/api/admin/ota/devices')).json()) as any).devices as any[];
  const rowDb = devs.find((d) => d.sn === SN_DB);
  const rowEnv = devs.find((d) => d.sn === SN_ENV);
  eq('note-1 台账设备行带人工备注', rowDb?.note, 'ota测试机');
  eq('note-2 台账无记录设备 note 为空串（字段恒在）', { has: rowEnv ? 'note' in rowEnv : null, n: rowEnv?.note }, { has: true, n: '' });
  eq('note-3 备注不影响原有字段', { vc: rowDb?.version_code, lr: rowDb?.last_result === undefined ? 'missing' : 'present' }, { vc: 62, lr: 'present' });
}

console.log(`\nota.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
