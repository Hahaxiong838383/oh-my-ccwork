/**
 * 服务器状态聚合回归测试 · 跑法：npm run test:hosts-status（tsx 直跑，无框架）
 *
 * 覆盖：
 *  - parseSnapshot：空 / 非 JSON / 数组 一律抛错；对象原样返回（老 stats.sh 无 schema 也接受）
 *  - describeExecError：超时 / 退出码+stderr 首行 / ENOENT / 普通 Error 四形态，且不带命令行原文
 *  - parseWorkerTargets/workerTargets/sumMaxJobs（2026-09-22 迁 hk2 多 worker）：legacy 回退 / 多机去重与标签 / 垃圾输入回退 / 求和只算采到的
 *  - getHostsStatus：三台并行、单台抛错只降级该台（ok:false + error），其余照常；30s 缓存命中不重采；
 *    过 TTL 重采；fresh=1 在 5s 内仍回缓存、过 5s 重采（时间用注入的 now 推进）
 *  - 路由：/api/admin/hosts-status 无 token 401；guest 403（admin 专属门）；admin 200 且载荷形状齐
 * 全程注入假采集器，不真连任何主机。
 */
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

process.env.CONFIG_DB_PATH = `${tmpdir()}/p003-hosts-status-test-${process.pid}.db`;
process.env.STUDIO_USER = 't-admin';
process.env.STUDIO_PASS = 't-pass-123456';
process.env.STUDIO_GUEST_USER = 'guest';
process.env.STUDIO_GUEST_PASS = '123456';
process.env.RELEASE_JSON_PATH = new URL('../release.json', import.meta.url).pathname;

const { authRoute } = await import('../src/routes/auth.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const hs = await import('../src/hosts-status.js');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}
function throws(name: string, fn: () => unknown, needle: string): void {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (e) {
    check(name, String((e as Error).message).includes(needle), (e as Error).message);
  }
}

// ── parseSnapshot ──
throws('parse-empty', () => hs.parseSnapshot('   \n'), 'empty');
throws('parse-badjson', () => hs.parseSnapshot('{not json'), 'bad json');
throws('parse-array', () => hs.parseSnapshot('[1,2]'), 'not a JSON object');
check('parse-legacy-object', hs.parseSnapshot('{"mem_total_mb":3915,"ts":1}\n').mem_total_mb === 3915);

// ── describeExecError ──
check('err-timeout', hs.describeExecError({ killed: true, signal: 'SIGTERM', message: 'Command failed: ssh -i /root/.ssh/k root@x' }) === 'timeout(12s)');
const exitDesc = hs.describeExecError({ code: 255, stderr: '\nroot@47.239.204.68: Permission denied (publickey).\n', message: 'Command failed: ssh -i /root/.ssh/k' });
check('err-exit-stderr', exitDesc === 'exit 255: root@47.239.204.68: Permission denied (publickey).', exitDesc);
check('err-exit-no-cmdline', !exitDesc.includes('ssh -i'), exitDesc);
check('err-enoent', hs.describeExecError({ code: 'ENOENT', message: 'spawn python3 ENOENT' }) === 'command not found');
check('err-plain', hs.describeExecError(new Error('bad json')) === 'bad json');

// 2026-09-22 迁 hk2：多 worker 目标解析 + 容量求和（纯函数，不连主机）
{
  const legacy = hs.parseWorkerTargets(undefined);
  check('wt-legacy-default', legacy.length === 1 && legacy[0].id === '64.90' && legacy[0].target === 'root@64.90.13.177' && legacy[0].host === '64.90.13.177', legacy);
  const legacyEnv = hs.parseWorkerTargets('', 'root@10.0.0.9');
  check('wt-legacy-env-target', legacyEnv.length === 1 && legacyEnv[0].id === '64.90' && legacyEnv[0].target === 'root@10.0.0.9' && legacyEnv[0].host === '10.0.0.9', legacyEnv);
  const multi = hs.parseWorkerTargets(' root@64.90.13.117|老机 · 生产池 , root@64.90.13.177|新机 · 单池 20 路 ,root@64.90.13.117, ,root@1.2.3.4 ');
  check('wt-multi-count-dedupe', multi.length === 3, multi.map((w) => w.target));
  check('wt-multi-id-label', multi[0].id === 'worker:64.90.13.117' && multi[0].label === '老机 · 生产池' && multi[1].id === 'worker:64.90.13.177' && multi[1].label === '新机 · 单池 20 路', multi);
  check('wt-multi-default-label', multi[2].label === '1.2.3.4 · 语音 worker' && multi[2].host === '1.2.3.4', multi[2]);
  const junk = hs.parseWorkerTargets(' , | , |x ');
  check('wt-junk-falls-back', junk.length === 1 && junk[0].id === '64.90', junk);
  check('sum-none', hs.sumMaxJobs([{ ok: false, data: null }, { ok: true, data: { max_jobs: 'x' } }]) === null);
  check('sum-partial', hs.sumMaxJobs([{ ok: true, data: { max_jobs: 10 } }, { ok: false, data: { max_jobs: 20 } }, { ok: true, data: { max_jobs: 20 } }]) === 30);
  const prevEnv = process.env.WORKER_STATS_SSH_TARGETS;
  process.env.WORKER_STATS_SSH_TARGETS = 'root@64.90.13.117|a,root@64.90.13.177|b';
  const ids = hs.workerTargets().map((w) => w.id).join(',');
  check('wt-env-two', ids === 'worker:64.90.13.117,worker:64.90.13.177', ids);
  if (prevEnv === undefined) delete process.env.WORKER_STATS_SSH_TARGETS;
  else process.env.WORKER_STATS_SSH_TARGETS = prevEnv;
  check('wt-env-unset-legacy', hs.workerTargets()[0].id === '64.90');
}

// ── getHostsStatus with injected collectors ──
let clock = 1_000_000;
const now = () => clock;
const calls = { a: 0, b: 0, c: 0 };
hs.setHostsStatusCollectorsForTest([
  { id: 'a', label: 'A', role: 'api', collect: async () => { calls.a += 1; return { schema: 'host-stats/1', role: 'api', host: { load1: 0.1 } }; } },
  { id: 'b', label: 'B', role: 'worker', collect: async () => { calls.b += 1; throw Object.assign(new Error('Command failed: ssh -i /root/.ssh/worker-stats-key root@64.90.13.117 stats'), { code: 255, stderr: 'ssh: connect to host 64.90.13.117 port 22: Connection timed out\n' }); } },
  { id: 'c', label: 'C', role: 'livekit', collect: async () => { calls.c += 1; return { mem_total_mb: 1612 }; } },
]);

const p1 = await hs.getHostsStatus({ now });
check('agg-3-hosts', p1.hosts.length === 3 && p1.ok === true && p1.cached === false, p1);
check('agg-order', p1.hosts.map((h) => h.id).join(',') === 'a,b,c');
check('agg-a-ok', p1.hosts[0].ok && p1.hosts[0].error === null && (p1.hosts[0].data as { role: string }).role === 'api');
check('agg-b-degraded', !p1.hosts[1].ok && p1.hosts[1].data === null && p1.hosts[1].error === 'exit 255: ssh: connect to host 64.90.13.117 port 22: Connection timed out', p1.hosts[1]);
check('agg-b-no-keypath-leak', !String(p1.hosts[1].error).includes('worker-stats-key'), p1.hosts[1].error);
check('agg-c-legacy-ok', p1.hosts[2].ok && (p1.hosts[2].data as { mem_total_mb: number }).mem_total_mb === 1612);
check('agg-calls-once', calls.a === 1 && calls.b === 1 && calls.c === 1, calls);

clock += 2_000;
const p2 = await hs.getHostsStatus({ now });
check('cache-hit-2s', p2.cached === true && calls.a === 1 && p2.ts === p1.ts, { cached: p2.cached, calls });

const p3 = await hs.getHostsStatus({ now, fresh: true });
check('fresh-within-5s-still-cached', p3.cached === true && calls.a === 1, { cached: p3.cached, calls });

clock += 4_000; // 距上次采集 6s：fresh 可重采，普通仍缓存
const p4 = await hs.getHostsStatus({ now });
check('cache-hit-6s', p4.cached === true && calls.a === 1);
const p5 = await hs.getHostsStatus({ now, fresh: true });
check('fresh-after-5s-recollects', p5.cached === false && calls.a === 2 && calls.b === 2 && calls.c === 2, { cached: p5.cached, calls });

clock += 29_000; // 距 p5 采集 29s：仍在 TTL 内
const p6 = await hs.getHostsStatus({ now });
check('cache-hit-29s', p6.cached === true && calls.a === 2);
clock += 2_000; // 31s：过 TTL
const p7 = await hs.getHostsStatus({ now });
check('ttl-expired-recollects', p7.cached === false && calls.a === 3, { cached: p7.cached, calls });

// ── 路由 + 权限门 ──
const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);
async function login(username: string, password: string): Promise<string> {
  const r = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = (await r.json()) as { ok: boolean; token: string };
  assert.equal(r.status, 200, `login ${username}`);
  return j.token;
}
const adminToken = await login('t-admin', 't-pass-123456');
const guestToken = await login('guest', '123456');

const r401 = await app.request('/api/admin/hosts-status');
check('route-401-no-token', r401.status === 401);
const r403 = await app.request('/api/admin/hosts-status', { headers: { Authorization: `Bearer ${guestToken}` } });
check('route-403-guest', r403.status === 403, r403.status);
const r200 = await app.request('/api/admin/hosts-status', { headers: { Authorization: `Bearer ${adminToken}` } });
check('route-200-admin', r200.status === 200, r200.status);
const body = (await r200.json()) as { ok: boolean; hosts: Array<{ id: string; ok: boolean; fetched_at_ms: number; latency_ms: number }>; ts: number; ttl_ms: number };
check('route-shape', body.ok === true && Array.isArray(body.hosts) && body.hosts.length === 3 && typeof body.ts === 'number' && body.ttl_ms === 30_000, body);
check('route-host-fields', body.hosts.every((h) => typeof h.id === 'string' && typeof h.ok === 'boolean' && typeof h.fetched_at_ms === 'number' && typeof h.latency_ms === 'number'));
const rFresh = await app.request('/api/admin/hosts-status?fresh=1', { headers: { Authorization: `Bearer ${adminToken}` } });
check('route-fresh-200', rFresh.status === 200);

hs.setHostsStatusCollectorsForTest(null);
console.log(`hosts-status tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
