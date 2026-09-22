/**
 * 服务器状态聚合（运营台「服务器状态」tab；2026-09-17 川哥：09-16 生产池 worker 退出复盘后要求
 * 「各服务器的资源和连接状态」在后台可见）。
 *
 * 三台机各跑同一份只读脚本 ops/host-stats.py（输出单行 JSON，schema host-stats/1）：
 *   aliyun-hk：本机，直接 python3 执行；
 *   64.90    ：沿用 /worker-stats 的 forced-command 只读 key（stats.sh 已改为转调 host-stats.py，老键保留）；
 *              2026-09-22 起可多台（WORKER_STATS_SSH_TARGETS，见 parseWorkerTargets），迁 hk2 并存期两台同屏；
 *   47.239   ：新增 livekit-stats-key forced-command → /root/host-stats.py。
 * 每台独立 try/catch 降级为 ok:false（错误只留一句可读原因），30s 共享缓存；?fresh=1 强制重采但 ≥5s 间隔。
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

export type HostCollector = () => Promise<HostSnapshot>;
export type HostSpec = { id: string; label: string; role: string; collect: HostCollector };

export const HOSTS_STATUS_TTL_MS = 30_000;
export const HOSTS_STATUS_MIN_FRESH_INTERVAL_MS = 5_000;
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
  if (err && (err.killed || err.signal)) return `timeout(${COLLECT_TIMEOUT_MS / 1000}s)`;
  const stderrLine = typeof err?.stderr === 'string' ? err.stderr.split('\n').find((l) => l.trim()) : undefined;
  if (typeof err?.code === 'number') return `exit ${err.code}${stderrLine ? `: ${stderrLine.trim().slice(0, 120)}` : ''}`;
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
 * worker 机列表（2026-09-22 迁 hk2：老机 64.90.13.117 与新机 64.90.13.177 并存期要同屏可见）。
 * env `WORKER_STATS_SSH_TARGETS="user@host|标签,user@host2|标签2"`（逗号分机，竖线后为可选标签）；
 * 未配 → 沿用单机 `WORKER_STATS_SSH_TARGET`（默认老机，id 保持 '64.90'，老页面/老测试不受影响）。
 */
export type WorkerTarget = { id: string; label: string; target: string; host: string };
const LEGACY_WORKER_TARGET = 'root@64.90.13.117';
const LEGACY_WORKER_LABEL = '64.90 · 语音 worker（生产池 / One-shot 池 / 租户）';

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

export function workerCollector(target: string): HostCollector {
  return sshCollector(workerStatsKeyPath(), target);
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
  return [
    { id: 'aliyun-hk', label: 'aliyun-hk · P003 API / 后台', role: 'api', collect: localCollector(script) },
    ...workerTargets().map((w) => ({ id: w.id, label: w.label, role: 'worker', collect: workerCollector(w.target) })),
    {
      id: '47.239',
      label: '47.239 · KidsHubAI-VoiceKit 信令 / 媒体（nginx TLS 终止）',
      role: 'livekit',
      collect: sshCollector(
        process.env.LIVEKIT_STATS_SSH_KEY || '/root/.ssh/livekit-stats-key',
        process.env.LIVEKIT_STATS_SSH_TARGET || 'root@47.239.204.68',
      ),
    },
  ];
}

let specsOverride: HostSpec[] | null = null;
let cache: { data: HostsStatusPayload; ts: number } | null = null;

/** 测试注入点：传 null 恢复真实采集器；每次注入都清缓存。 */
export function setHostsStatusCollectorsForTest(specs: HostSpec[] | null): void {
  specsOverride = specs;
  cache = null;
}

async function collectOne(spec: HostSpec, now: () => number): Promise<HostStatus> {
  const t0 = now();
  try {
    const data = await spec.collect();
    return { id: spec.id, label: spec.label, role: spec.role, ok: true, error: null, data, fetched_at_ms: now(), latency_ms: now() - t0 };
  } catch (e) {
    return {
      id: spec.id,
      label: spec.label,
      role: spec.role,
      ok: false,
      error: describeExecError(e),
      data: null,
      fetched_at_ms: now(),
      latency_ms: now() - t0,
    };
  }
}

/**
 * 三台并行采集。缓存 30s；fresh=true 跳过缓存但距上次采集 <5s 仍回缓存（防狂点重采打爆 ssh）。
 * now 可注入（测试推进时间）。
 */
export async function getHostsStatus(opts: { fresh?: boolean; now?: () => number } = {}): Promise<HostsStatusPayload> {
  const now = opts.now ?? Date.now;
  const t = now();
  if (cache) {
    const age = t - cache.ts;
    if (!opts.fresh && age < HOSTS_STATUS_TTL_MS) return { ...cache.data, cached: true };
    if (opts.fresh && age < HOSTS_STATUS_MIN_FRESH_INTERVAL_MS) return { ...cache.data, cached: true };
  }
  const specs = specsOverride ?? defaultSpecs();
  const hosts = await Promise.all(specs.map((s) => collectOne(s, now)));
  const data: HostsStatusPayload = { ok: true, ts: now(), ttl_ms: HOSTS_STATUS_TTL_MS, cached: false, hosts };
  cache = { data, ts: data.ts };
  return data;
}
