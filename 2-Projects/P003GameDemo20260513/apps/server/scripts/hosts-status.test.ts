/**
 * 服务器状态聚合回归测试 · 跑法：node --experimental-sqlite --import tsx scripts/hosts-status.test.ts
 * 仅采集层（无需完整 admin 路由依赖）：加 HOSTS_STATUS_UNIT_ONLY=1。
 *
 * 覆盖：
 *  - parseSnapshot：空 / 非 JSON / 数组 一律抛错；对象原样返回（老 stats.sh 无 schema 也接受）
 *  - describeExecError：SSH 警告边框 / 超时与外部信号 / 输出超限 / ENOENT，且不带命令行原文
 *  - parseWorkerTargets/workerTargets/sumMaxJobs（2026-09-22 迁 hk2 多 worker）：legacy 回退 / 多机去重与标签 / 垃圾输入回退 / 求和只算采到的
 *  - getHostsStatus：三台并行，单台失败隔离；成功缓存 30s、失败/部分采集 5s；并发与跨接口共用采集；
 *    fresh=1 遵守 5s 最小间隔、过 5s 重采（时间用注入的 now 推进）
 *  - 路由：/api/admin/hosts-status 无 token 401；guest 403（admin 专属门）；admin 200 且载荷形状齐
 * 全程注入假采集器或临时 ssh 可执行文件，不真连任何主机。
 */
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';

process.env.CONFIG_DB_PATH = `${tmpdir()}/p003-hosts-status-test-${process.pid}.db`;
process.env.STUDIO_USER = 't-admin';
process.env.STUDIO_PASS = 't-pass-123456';
process.env.STUDIO_GUEST_USER = 'guest';
process.env.STUDIO_GUEST_PASS = '123456';
process.env.RELEASE_JSON_PATH = new URL('../release.json', import.meta.url).pathname;

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
const hostKeyWarning = hs.describeExecError({ code: 255, stderr: '@@@@@@@@@@@@@@@@@@@@@@@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n' });
check('err-host-key-reason-not-border', hostKeyWarning.includes('REMOTE HOST IDENTIFICATION HAS CHANGED') && hostKeyWarning.includes('Host key verification failed') && !hostKeyWarning.includes('@@@'), hostKeyWarning);
const keyPermissions = hs.describeExecError({ code: 255, stderr: '@@@@@@@@@@@@@@@\n@ WARNING: UNPROTECTED PRIVATE KEY FILE! @\n@@@@@@@@@@@@@@@\nPermissions 0644 for /root/.ssh/worker-stats-key are too open.\n' });
check('err-private-key-warning-distinct', keyPermissions.includes('UNPROTECTED PRIVATE KEY FILE') && !keyPermissions.includes('@@@'), keyPermissions);
check('err-signal-not-timeout', hs.describeExecError({ signal: 'SIGKILL', killed: false }) === 'signal SIGKILL');
check('err-buffer-kill-not-timeout', hs.describeExecError({ signal: 'SIGTERM', killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) === 'output limit exceeded');

// 同一慢采集尚未结束时，普通刷新和 fresh 必须等待同一个任务。
{
  let callCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  hs.setHostsStatusCollectorsForTest([{ id: 'slow', label: 'slow', role: 'worker', collect: async () => {
    callCount += 1;
    await gate;
    return { errors: ['worker journal truncated'], max_jobs: 20 };
  } }]);
  const pending = [hs.getHostsStatus(), hs.getHostsStatus(), hs.getHostsStatus({ fresh: true })];
  await Promise.resolve();
  release();
  const results = await Promise.all(pending);
  check('concurrent-normal-fresh-single-collection', callCount === 1, callCount);
  check('partial-errors-preserved', results.every((r) => (r.hosts[0].data?.errors as string[])?.[0] === 'worker journal truncated'));
}

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
check('failure-retries-after-5s-success-stays-cached', p4.cached === false && calls.a === 1 && calls.b === 2, calls);
const p5 = await hs.getHostsStatus({ now, fresh: true });
check('fresh-after-5s-recollects', p5.cached === false && calls.a === 2 && calls.b === 2 && calls.c === 2, { cached: p5.cached, calls });

clock += 29_000; // 距 p5 采集 29s：仍在 TTL 内
const p6 = await hs.getHostsStatus({ now });
check('success-cache-hit-29s-failure-retried', p6.cached === false && calls.a === 2 && calls.b === 3, calls);
clock += 2_000; // 31s：过 TTL
const p7 = await hs.getHostsStatus({ now });
check('ttl-expired-recollects', p7.cached === false && calls.a === 3, { cached: p7.cached, calls });

// 有告警的 JSON 仍保留所有已采集字段，5s 后重试，不伪造完整健康状态。
{
  let partialCalls = 0;
  const partialSpec = { id: 'partial', label: 'partial', role: 'worker', collect: async () => {
    partialCalls += 1;
    return { errors: ['journal timed out'], max_jobs: 20, connections: { worker_links: [] } };
  } };
  hs.setHostsStatusCollectorsForTest([partialSpec]);
  const first = await hs.getHostsStatus({ now });
  clock += 4_999;
  await hs.getHostsStatus({ now });
  check('partial-cached-within-5s', partialCalls === 1);
  clock += 1;
  const retried = await hs.getHostsStatus({ now });
  check('partial-retries-at-5s', partialCalls === 2 && retried.cached === false);
  check('partial-does-not-invent-link-health', first.hosts[0].data?.max_jobs === 20 && JSON.stringify(first.hosts[0].data?.connections) === '{"worker_links":[]}');
}

// 用临时 ssh 可执行文件走真实 execFile 边界，不连网络，验证两个入口共享同一缓存/执行中任务。
{
  const fixture = await mkdtemp(path.join(tmpdir(), 'p003-hosts-collector-'));
  const keys = ['PATH', 'WORKER_STATS_SSH_TARGETS', 'WORKER_STATS_SSH_TARGET', 'WORKER_STATS_SSH_KEY', 'LIVEKIT_STATS_SSH_TARGET', 'LIVEKIT_STATS_SSH_KEY', 'HOSTS_STATUS_LOCAL_SCRIPT', 'HOSTS_TEST_DIR'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const target = 'monitor@worker.invalid';
  const logFile = path.join(fixture, 'calls.log');
  const modeFile = path.join(fixture, 'mode');
  const countWorker = async () => (await readFile(logFile, 'utf8')).split('\n').filter((line) => line === target).length;
  try {
    await writeFile(logFile, '');
    await writeFile(modeFile, 'ok');
    await writeFile(path.join(fixture, 'local.py'), 'print("{\\"role\\":\\"api\\"}")\n');
    await writeFile(path.join(fixture, 'ssh'), `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.HOSTS_TEST_DIR;
const target = process.argv.at(-2);
fs.appendFileSync(dir + '/calls.log', target + '\\n');
const sample = fs.readFileSync(dir + '/calls.log', 'utf8').split('\\n').filter(x => x === target).length;
setTimeout(() => {
  if (target === 'monitor@worker.invalid' && fs.readFileSync(dir + '/mode', 'utf8') === 'fail') {
    process.stderr.write('Permission denied (publickey).\\n'); process.exitCode = 255;
  } else process.stdout.write(JSON.stringify({ max_jobs: 20, sample, errors: [] }));
}, 30);
`, { mode: 0o700 });
    process.env.PATH = `${fixture}:${process.env.PATH}`;
    process.env.HOSTS_TEST_DIR = fixture;
    process.env.WORKER_STATS_SSH_TARGETS = `${target}|test worker`;
    process.env.WORKER_STATS_SSH_KEY = path.join(fixture, 'dummy-key');
    process.env.LIVEKIT_STATS_SSH_TARGET = 'monitor@media.invalid';
    process.env.LIVEKIT_STATS_SSH_KEY = path.join(fixture, 'dummy-key');
    process.env.HOSTS_STATUS_LOCAL_SCRIPT = path.join(fixture, 'local.py');
    hs.setHostsStatusCollectorsForTest(null);
    const deviceCardCollect = hs.workerCollector(target);
    const initial = await Promise.all([deviceCardCollect({ now }), hs.getHostsStatus({ now }), hs.getHostsStatus({ now, fresh: true })]);
    check('worker-and-hosts-share-inflight', await countWorker() === 1 && initial[0].sample === 1);
    clock += 6_000;
    const fresh = await hs.getHostsStatus({ now, fresh: true });
    const afterFresh = await deviceCardCollect({ now });
    check('hosts-fresh-updates-device-card-cache', await countWorker() === 2 && afterFresh.sample === 2 && fresh.hosts.find((h) => h.role === 'worker')?.data?.sample === 2);
    await writeFile(modeFile, 'fail');
    clock += 6_000;
    const failed = await hs.getHostsStatus({ now, fresh: true });
    const failedCard = await deviceCardCollect({ now }).then(() => 'unexpected success', hs.describeExecError);
    check('worker-failure-shared-across-interfaces', await countWorker() === 3 && !failed.hosts.find((h) => h.role === 'worker')?.ok && failedCard === 'exit 255: Permission denied (publickey).', failedCard);
    await writeFile(modeFile, 'ok');
    clock += 4_999;
    await deviceCardCollect({ now, fresh: true }).catch(() => null);
    check('failed-fresh-respects-5s-backoff', await countWorker() === 3);
    clock += 1;
    const recovered = await deviceCardCollect({ now });
    const hostsAfterRecovery = await hs.getHostsStatus({ now });
    check('failed-worker-retries-at-5s', await countWorker() === 4 && recovered.sample === 4);
    check('device-card-recovery-immediately-visible-in-hosts', hostsAfterRecovery.hosts.find((h) => h.role === 'worker')?.data?.sample === 4);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    hs.setHostsStatusCollectorsForTest(null);
    await rm(fixture, { recursive: true, force: true });
  }
}

// ── 路由 + 权限门 ──
if (process.env.HOSTS_STATUS_UNIT_ONLY !== '1') {
hs.setHostsStatusCollectorsForTest([
  { id: 'a', label: 'A', role: 'api', collect: async () => ({ role: 'api' }) },
  { id: 'b', label: 'B', role: 'worker', collect: async () => ({ max_jobs: 20 }) },
  { id: 'c', label: 'C', role: 'livekit', collect: async () => ({ role: 'livekit' }) },
]);
const { authRoute } = await import('../src/routes/auth.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
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
}

hs.setHostsStatusCollectorsForTest(null);
console.log(`hosts-status tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
