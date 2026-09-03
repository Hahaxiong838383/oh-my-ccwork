/**
 * 设备运行配置回归测试 · 跑法：npm run test:device-config（tsx 直跑，无框架）
 *
 * 覆盖（联调合同 + cc 回执冻结项逐条对应）：
 *  - 设备 GET 鉴权：无凭据 401 / 台账外 403 / env 白名单放行 / 限频 429
 *  - 快照形状：schema_version=1 + 非空 revision + 全键完整（零配置时内置默认 900 / cfg-0）
 *  - 合成优先级：SN 覆盖 > 全局 > 内置；清覆盖回落全局
 *  - revision 单调：任何保存/清除都 bump；清除不倒退（tombstone）；
 *    全局变更连带有覆盖设备 revision 变化（回执 §2 幂等口径边界）
 *  - admin 校验：范围外/非整数/字符串/未知键全拒；总览形状
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'devcfg-test-'));
process.env.CONFIG_DB_PATH = join(tmp, 'config.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.AUTH_JWT_SECRET = 'test-secret';
process.env.DEVICE_SN_ALLOW = 'BJP00326060100000777';
process.env.DEVICE_CONFIG_RPM = '100'; // 功能段放宽（cfg 每请求读 env）；限频专项段单独收紧

const { Hono } = await import('hono');
const { SignJWT } = await import('jose');
const { deviceConfigRoute, configAdminRoute } = await import('../src/routes/device-config.js');
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
app.route('/v1/device/config', deviceConfigRoute);
app.route('/api/admin/device-config', configAdminRoute);

const SECRET = new TextEncoder().encode('test-secret');
async function deviceCred(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device' })
    .setSubject(sn)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(SECRET);
}

async function pull(cred?: string) {
  const res = await app.request('/v1/device/config', {
    headers: cred ? { authorization: `Bearer ${cred}` } : {},
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

async function adminPut(path: string, body: unknown) {
  const res = await app.request(`/api/admin/device-config${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const SN_DB = 'BJP00326060100000601'; // 台账 active
const SN_ENV = 'BJP00326060100000777'; // 仅 env 白名单
const SN_OUT = 'BJP00326060100000999'; // 都不在
deviceRegistryStore.add(SN_DB, '配置测试机');

// ---------- 鉴权 ----------
eq('auth-1 无凭据 401', (await pull()).status, 401);
eq('auth-2 台账外 403', (await pull(await deviceCred(SN_OUT))).status, 403);

// ---------- 零配置快照：内置默认 + cfg-0 ----------
{
  const r = await pull(await deviceCred(SN_ENV));
  eq('snap-1 零配置完整快照', r.json, {
    schema_version: 1,
    revision: 'cfg-0',
    posture: { reminder_cooldown_sec: 900 },
  });
}

// ---------- admin 校验门（合法范围 10~86400 整数）----------
const KEY = 'posture.reminder_cooldown_sec';
eq('val-1 9 拒', (await adminPut('/global', { key: KEY, value: 9 })).status, 400);
eq('val-2 86401 拒', (await adminPut('/global', { key: KEY, value: 86401 })).status, 400);
eq('val-3 非整数拒', (await adminPut('/global', { key: KEY, value: 30.5 })).status, 400);
eq('val-4 字符串拒', (await adminPut('/global', { key: KEY, value: '30' })).status, 400);
eq('val-5 未知键拒', (await adminPut('/global', { key: 'posture.nope', value: 30 })).status, 400);
eq('val-6 边界 10 收', (await adminPut('/global', { key: KEY, value: 10 })).status, 200);
eq('val-7 边界 86400 收', (await adminPut('/global', { key: KEY, value: 86400 })).status, 200);

// ---------- 合成优先级 + revision ----------
{
  await adminPut('/global', { key: KEY, value: 600 }); // rev=3
  const g = await pull(await deviceCred(SN_DB));
  eq('merge-1 全局生效', g.json.posture.reminder_cooldown_sec, 600);
  eq('merge-2 revision 跟全局', g.json.revision, 'cfg-3');

  await adminPut(`/sn/${SN_DB}`, { key: KEY, value: 30 }); // rev=4
  const s = await pull(await deviceCred(SN_DB));
  eq('merge-3 SN 覆盖优先', s.json.posture.reminder_cooldown_sec, 30);
  eq('merge-4 覆盖 revision', s.json.revision, 'cfg-4');

  const other = await pull(await deviceCred(SN_ENV));
  eq('merge-5 无覆盖设备不受影响', { v: other.json.posture.reminder_cooldown_sec, rev: other.json.revision }, { v: 600, rev: 'cfg-3' });

  // 全局变更 → 有覆盖设备值不变但 revision 变（回执 §2 幂等口径边界，显式断言防漂移）
  await adminPut('/global', { key: KEY, value: 700 }); // rev=5
  const s2 = await pull(await deviceCred(SN_DB));
  eq('merge-6 全局变更连带覆盖设备 rev 变', { v: s2.json.posture.reminder_cooldown_sec, rev: s2.json.revision }, { v: 30, rev: 'cfg-5' });

  // 清覆盖：回落全局 + revision 单调不倒退（tombstone）
  const del = await app.request(`/api/admin/device-config/sn/${SN_DB}?key=${KEY}`, { method: 'DELETE' });
  eq('merge-7 清覆盖 200', del.status, 200);
  const s3 = await pull(await deviceCred(SN_DB));
  eq('merge-8 回落全局且 rev 前进', { v: s3.json.posture.reminder_cooldown_sec, rev: s3.json.revision }, { v: 700, rev: 'cfg-6' });
}

// ---------- admin 总览形状 ----------
{
  await adminPut(`/sn/${SN_ENV}`, { key: KEY, value: 1200 }); // rev=7
  const res = await app.request('/api/admin/device-config');
  const j = (await res.json()) as any;
  eq('admin-1 键注册表', { key: j.keys[0].key, builtin: j.keys[0].builtin_default, global: j.keys[0].global }, { key: KEY, builtin: 900, global: 700 });
  eq('admin-2 覆盖列表(tombstone 不列)', j.overrides.map((o: any) => ({ sn: o.sn, value: o.value })), [{ sn: SN_ENV, value: 1200 }]);
  eq('admin-3 坏 SN 拒', (await adminPut('/sn/NOT-A-SN', { key: KEY, value: 30 })).status, 400);
  eq('admin-4 清未知键拒', (await app.request(`/api/admin/device-config/sn/${SN_DB}?key=wat`, { method: 'DELETE' })).status, 400);
}

// ---------- server 自用键 local_audio.refresh_days（2026-09-03）：不进设备快照、不动设备 revision ----------
{
  const { configStore, CONFIG_KEYS } = await import('../src/config-store.js');
  const K2 = 'local_audio.refresh_days';
  eq('srv-1 已注册且标 server_only', CONFIG_KEYS[K2]?.serverOnly, true);
  const credDb = await deviceCred(SN_DB);
  const before = await pull(credDb);
  eq('srv-2 设备快照不含 server 键(设备合同键集不变)', { st: before.status, la: before.json.local_audio }, { st: 200, la: undefined });
  eq('srv-3 内置默认 3', configStore.getEffective(SN_DB, K2), 3);
  eq(
    'srv-4 越界拒 0/31/非整数',
    [
      (await adminPut('/global', { key: K2, value: 0 })).status,
      (await adminPut('/global', { key: K2, value: 31 })).status,
      (await adminPut('/global', { key: K2, value: 2.5 })).status,
    ],
    [400, 400, 400],
  );
  const bad = await adminPut('/global', { key: K2, value: 31 });
  eq('srv-4b 提示文案随键表', bad.json.message, '取值须为 1~30 的整数天');
  eq('srv-5 全局设 5 收', (await adminPut('/global', { key: K2, value: 5 })).status, 200);
  const after = await pull(credDb);
  eq('srv-6 设备 revision 不因 server 键变(负锚:设备合同 revision 不受污染)', after.json.revision, before.json.revision);
  eq('srv-7 getEffective 走全局', configStore.getEffective(SN_DB, K2), 5);
  eq('srv-8 SN 覆盖优先', (await adminPut(`/sn/${SN_DB}`, { key: K2, value: 2 })).status === 200 ? configStore.getEffective(SN_DB, K2) : -1, 2);
  eq('srv-9 其他 SN 仍走全局', configStore.getEffective(SN_ENV, K2), 5);
  const after2 = await pull(credDb);
  eq('srv-10 SN 覆盖 server 键也不动设备 revision', after2.json.revision, before.json.revision);
  const oj = (await (await app.request('/api/admin/device-config')).json()) as any;
  const k2 = oj.keys.find((k: any) => k.key === K2);
  eq('srv-11 admin 总览含 server 键元数据', { so: k2?.server_only, g: k2?.global, unit: k2?.unit, min: k2?.min, max: k2?.max }, { so: true, g: 5, unit: 'day', min: 1, max: 30 });
  eq('srv-12 正锚:改设备键仍会动设备 revision', (await adminPut('/global', { key: KEY, value: 777 })).status === 200 ? (await pull(credDb)).json.revision !== before.json.revision : false, true);
}

// ---------- 限频（独立 SN + 临时收紧 RPM=6：第 7 次必 429）----------
{
  const SN_RATE = 'BJP00326060100000888';
  deviceRegistryStore.add(SN_RATE, '限频测试机');
  process.env.DEVICE_CONFIG_RPM = '6';
  const cred = await deviceCred(SN_RATE);
  let last = 0;
  for (let i = 0; i < 8; i += 1) last = (await pull(cred)).status;
  eq('rate-1 风暴 429', last, 429);
  process.env.DEVICE_CONFIG_RPM = '100';
}

console.log(`\ndevice-config.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
