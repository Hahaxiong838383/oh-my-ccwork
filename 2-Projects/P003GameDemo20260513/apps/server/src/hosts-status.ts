/**
 * 服务器状态聚合（运营台「服务器状态」tab；2026-09-17 川哥：09-16 生产池 worker 退出复盘后要求
 * 「各服务器的资源和连接状态」在后台可见）。
 *
 * 三台机各跑同一份只读脚本 ops/host-stats.py（输出单行 JSON，schema host-stats/1）：
 *   aliyun-hk：本机，直接 python3 执行；
 *   64.90    ：沿用 /worker-stats 的 forced-command 只读 key（stats.sh 已改为转调 host-stats.py，老键保留）；
 *              2026-09-22 起可多台（WORKER_STATS_SSH_TARGETS，见 parseWorkerTargets），迁 hk2 并存期两台同屏；
 *   47.239   ：新增 livekit-stats-key forced-command → /root/host-stats.py。
 * 每台独立 try/catch 降级为 ok:false；按采集目标共享缓存和执行中任务（包括 /worker-stats）。
 * 成功缓存 30s，失败/部分采集缓存 5s；?fresh=1 跳过成功缓存但仍遵守 5s 最小间隔。
 * 监控绝不拖垮管理页：单台超时 12s，三台并行。
 * 测试注入：setHostsStatusCollectorsForTest（不真连主机）。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);

export type HostSnapshot = Record<string, unknown>;
export type HostStatus = {
  id: string;
  label: string;
  role: string;
  ok: boolean;
  error: string | null;
  data: HostSnapshot | null;
  fetched_at_ms: number;
  latency_ms: number;
};
export type HostsStatusPayload = {
  ok: true;
  ts: number;
  ttl_ms: number;
  cached: boolean;
  hosts: HostStatus[];
};

export type CollectOptions = { fresh?: boolean; now?: () => number };
export type HostCollector = (opts?: CollectOptions) => Promise<HostSnapshot>;
export type HostSpec = { id: string; label: string; role: string; collect: HostCollector; cacheKey?: string };

export const HOSTS_STATUS_TTL_MS = 30_000;
export const HOSTS_STATUS_MIN_FRESH_INTERVAL_MS = 5_000;
const FAILED_COLLECTION_TTL_MS = 5_000;
const MAX_CACHED_COLLECTORS = 64;
const COLLECT_TIMEOUT_MS = 12_000;
const SSH_BASE_ARGS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];

/** 脚本输出 → 对象；空输出 / 非对象 / 非 JSON 一律抛错（由调用方降级为 ok:false）。 */
export function parseSnapshot(raw: string): HostSnapshot {
  const text = raw.trim();
  if (!text) throw new Error('empty output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('bad json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
  return parsed as HostSnapshot;
}

/** execFile 错误 → 一句可读原因（不带命令行原文，避免把 key 路径/目标机塞进页面）。 */
export function describeExecError(e: unknown): string {
  const err = e as { killed?: boolean; signal?: string; code?: unknown; stderr?: unknown; message?: string };
  if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output limit exceeded';
  // execFile 的自身超时会标 killed + SIGTERM；外部信号终止不能误报为超时。
  if (err?.code === 'ETIMEDOUT' || (err?.killed && err.signal === 'SIGTERM' && err.code == null)) return `timeout(${COLLECT_TIMEOUT_MS / 1000}s)`;
  if (err?.signal) return `signal ${err.signal}`;
  const stderrLines = typeof err?.stderr === 'string'
    ? err.stderr.split('\n').map((line) => line.trim().replace(/^@+\s*|\s*@+$/g, '').trim()).filter(Boolean)
    : [];
  // SSH 的警告框首行只有 @；保留警告标题与最终失败原因，而不是装饰边框。
  const reasonLines = stderrLines.filter((line) => /warning:|failed|denied|too open|timed out|refused|no route|resolve hostname|offending/i.test(line));
  const stderrReason = (reasonLines.length ? reasonLines : stderrLines).slice(0, 3).join(' · ').slice(0, 400);
  if (typeof err?.code === 'number') return `exit ${err.code}${stderrReason ? `: ${stderrReason}` : ''}`;
  if (typeof err?.code === 'string' && err.code === 'ENOENT') return 'command not found';
  const msg = typeof err?.message === 'string' ? err.message.split('\n')[0] : String(e);
  return msg.slice(0, 160);
}

function sshCollector(keyPath: string, target: string): HostCollector {
  return async () => {
    const { stdout } = await pexecFile('ssh', ['-i', keyPath, ...SSH_BASE_ARGS, target, 'stats'], {
      timeout: COLLECT_TIMEOUT_MS,
      maxBuffer: 1 << 20,
    });
    return parseSnapshot(stdout);
  };
}

function localCollector(script: string): HostCollector {
  return async () => {
    const { stdout } = await pexecFile('python3', [script], { timeout: COLLECT_TIMEOUT_MS, maxBuffer: 1 << 20 });
    return parseSnapshot(stdout);
  };
}

/**
 * worker 机列表（2026-09-22 迁 hk2：老机 64.90.13.117 与新机 64.90.13.177 并存期要同屏可见；
 * 2026-09-23 阶段 3：默认单机改指新机 voice-worker-hk2，老机只剩租户/demo 线，靠 env 多机列表保留其行）。
 * env `WORKER_STATS_SSH_TARGETS="user@host|标签,user@host2|标签2"`（逗号分机，竖线后为可选标签）；
 * 未配 → 沿用单机 `WORKER_STATS_SSH_TARGET`（默认新机，id 保持 '64.90'，老页面/老测试不受影响）。
 */
export type WorkerTarget = { id: string; label: string; target: string; host: string };
const LEGACY_WORKER_TARGET = 'root@64.90.13.177';
const LEGACY_WORKER_LABEL = 'voice-worker-hk2 · 语音 worker 单池（20 路）';

export function parseWorkerTargets(raw: string | undefined, legacyTarget: string = LEGACY_WORKER_TARGET): WorkerTarget[] {
  const entries = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: WorkerTarget[] = [];
  for (const entry of entries) {
    const [t, ...rest] = entry.split('|');
    const target = (t ?? '').trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    const host = target.replace(/^[^@]*@/, '');
    const label = rest.join('|').trim() || `${host} · 语音 worker`;
    out.push({ id: `worker:${host}`, label, target, host });
  }
  if (out.length) return out;
  return [{ id: '64.90', label: LEGACY_WORKER_LABEL, target: legacyTarget, host: legacyTarget.replace(/^[^@]*@/, '') }];
}

export function workerTargets(): WorkerTarget[] {
  return parseWorkerTargets(process.env.WORKER_STATS_SSH_TARGETS, process.env.WORKER_STATS_SSH_TARGET || LEGACY_WORKER_TARGET);
}

export function workerStatsKeyPath(): string {
  return process.env.WORKER_STATS_SSH_KEY || '/root/.ssh/worker-stats-key';
}

function sshCacheKey(keyPath: string, target: string): string {
  return JSON.stringify(['ssh', keyPath, target]);
}

export function workerCollector(target: string): HostCollector {
  const keyPath = workerStatsKeyPath();
  const collect = sshCollector(keyPath, target);
  return async (opts = {}) => {
    const { result } = await collectShared(sshCacheKey(keyPath, target), collect, opts);
    if (!result.ok) throw result.error;
    return result.data;
  };
}

/** 接入容量：多台 worker 的 max_jobs 求和（只算采到数字的机器；一台都没有 → null）。 */
export function sumMaxJobs(machines: Array<{ ok: boolean; data: HostSnapshot | null }>): number | null {
  let sum: number | null = null;
  for (const m of machines) {
    const v = m.ok && m.data ? m.data.max_jobs : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) sum = (sum ?? 0) + v;
  }
  return sum;
}

function defaultSpecs(): HostSpec[] {
  const script = process.env.HOSTS_STATUS_LOCAL_SCRIPT || path.resolve(process.cwd(), 'ops/host-stats.py');
  const workerKey = workerStatsKeyPath();
  const livekitKey = process.env.LIVEKIT_STATS_SSH_KEY || '/root/.ssh/livekit-stats-key';
  const livekitTarget = process.env.LIVEKIT_STATS_SSH_TARGET || 'root@47.239.204.68';
  return [
    { id: 'aliyun-hk', label: 'aliyun-hk · P003 API / 后台', role: 'api', collect: localCollector(script), cacheKey: JSON.stringify(['local', script]) },
    ...workerTargets().map((w) => ({ id: w.id, label: w.label, role: 'worker', collect: sshCollector(workerKey, w.target), cacheKey: sshCacheKey(workerKey, w.target) })),
    {
      id: '47.239',
      label: '47.239 · KidsHubAI-VoiceKit 信令 / 媒体（nginx TLS 终止）',
      role: 'livekit',
      collect: sshCollector(livekitKey, livekitTarget),
      cacheKey: sshCacheKey(livekitKey, livekitTarget),
    },
  ];
}

let specsOverride: HostSpec[] | null = null;
type Collected = ({ ok: true; data: HostSnapshot } | { ok: false; error: unknown }) & { ts: number; latency: number };
type CacheEntry = { result?: Collected; inflight?: Promise<Collected> };
const collectorCache = new Map<string | HostCollector, CacheEntry>();

function collectionTtl(result: Collected): number {
  return !result.ok || (Array.isArray(result.data.errors) && result.data.errors.length > 0)
    ? FAILED_COLLECTION_TTL_MS : HOSTS_STATUS_TTL_MS;
}

/** 唯一缓存层：相同目标共享正在执行的任务；缓存有界，不随配置历史无限增长。 */
async function collectShared(key: string | HostCollector, collect: HostCollector, opts: CollectOptions): Promise<{ result: Collected; cached: boolean }> {
  const now = opts.now ?? Date.now;
  let entry = collectorCache.get(key);
  if (entry) {
    // 最近使用项移至末尾，回收时先淘汰闲置项；绝不淘汰正在执行的任务。
    collectorCache.delete(key);
    collectorCache.set(key, entry);
    if (entry.inflight) return { result: await entry.inflight, cached: true };
    if (entry.result) {
      const age = now() - entry.result.ts;
      const ttl = opts.fresh ? HOSTS_STATUS_MIN_FRESH_INTERVAL_MS : collectionTtl(entry.result);
      if (age >= 0 && age < ttl) return { result: entry.result, cached: true };
    }
  } else {
    if (collectorCache.size >= MAX_CACHED_COLLECTORS) {
      const idle = [...collectorCache].find(([, candidate]) => !candidate.inflight);
      if (idle) collectorCache.delete(idle[0]);
      else return { result: { ok: false, error: new Error('collector concurrency limit reached'), ts: now(), latency: 0 }, cached: false };
    }
    entry = {};
    collectorCache.set(key, entry);
  }
  const current = entry;
  const t0 = now();
  // 微任务启动确保 inflight 在实际采集开始之前就可供所有调用方共享。
  const pending = Promise.resolve().then(async (): Promise<Collected> => {
    try {
      const data = await collect();
      return { ok: true, data, ts: now(), latency: now() - t0 };
    } catch (error) {
      return { ok: false, error, ts: now(), latency: now() - t0 };
    }
  });
  current.inflight = pending;
  const result = await pending;
  current.result = result;
  current.inflight = undefined;
  return { result, cached: false };
}

/** 测试注入点：传 null 恢复真实采集器；每次注入都清缓存。 */
export function setHostsStatusCollectorsForTest(specs: HostSpec[] | null): void {
  specsOverride = specs;
  collectorCache.clear();
}

async function collectOne(spec: HostSpec, opts: CollectOptions): Promise<{ host: HostStatus; cached: boolean }> {
  const { result, cached } = await collectShared(spec.cacheKey ?? spec.collect, spec.collect, opts);
  return {
    cached,
    host: {
      id: spec.id,
      label: spec.label,
      role: spec.role,
      ok: result.ok,
      error: result.ok ? null : describeExecError(result.error),
      data: result.ok ? result.data : null,
      fetched_at_ms: result.ts,
      latency_ms: result.latency,
    },
  };
}

/**
 * 三台并行采集，不再叠加聚合缓存。fresh=true 跳过成功缓存，但任何目标完成后 5s 内不重采。
 * now 可注入（测试推进时间）。
 */
export async function getHostsStatus(opts: CollectOptions = {}): Promise<HostsStatusPayload> {
  const now = opts.now ?? Date.now;
  const specs = specsOverride ?? defaultSpecs();
  const results = await Promise.all(specs.map((s) => collectOne(s, opts)));
  const hosts = results.map((result) => result.host);
  return { ok: true, ts: hosts.length ? Math.max(...hosts.map((host) => host.fetched_at_ms)) : now(), ttl_ms: HOSTS_STATUS_TTL_MS, cached: results.every((result) => result.cached), hosts };
}
