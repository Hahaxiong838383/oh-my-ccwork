import type { FlowState } from "@evodesk/shared";
import {
  type ProviderConfig,
  type ProviderHealth,
  type Registry,
  type SlotName,
} from "./registry.js";
import { K_ROUTER_FAIL_CLOSED_CODE, selectProvider } from "./router.js";
import { recordDecision } from "./telemetry.js";

export const K_FALLBACK_MAX_RETRIES = 3;
export const K_CIRCUIT_BREAKER_THRESHOLD = 5;
export const K_CIRCUIT_BREAKER_WINDOW_MS = 60_000;

export interface FallbackResult {
  provider: ProviderConfig;
  attempts: number;
  fallbackPath: string[];
  durationMs: number;
}

type CircuitState = {
  failures: number;
  openedAt?: number;
};

// V1.5.2 B14-5 熔断长尾监控（2026-04-19）
// 轻量内存 Map，不落 SQLite（升级至 B 方案需 SLA 归档时再做）
export interface ProviderCircuitMetric {
  openCount: number;
  lastOpenedAt?: number;
  currentlyOpenSince?: number;
  lastRecoveryMs?: number;
  recoveryCount: number;
}

const providerCircuitMetrics = new Map<string, ProviderCircuitMetric>();

function metricsFor(id: string): ProviderCircuitMetric {
  let m = providerCircuitMetrics.get(id);
  if (!m) {
    m = { openCount: 0, recoveryCount: 0 };
    providerCircuitMetrics.set(id, m);
  }
  return m;
}

function markOpen(id: string, ts: number): void {
  const m = metricsFor(id);
  if (m.currentlyOpenSince === undefined) {
    m.openCount += 1;
    m.currentlyOpenSince = ts;
  }
  m.lastOpenedAt = ts;
}

function markRecovery(id: string, ts: number): void {
  const m = providerCircuitMetrics.get(id);
  if (!m || m.currentlyOpenSince === undefined) return;
  m.lastRecoveryMs = ts - m.currentlyOpenSince;
  m.recoveryCount += 1;
  m.currentlyOpenSince = undefined;
}

export function getCircuitMetrics(): Record<string, ProviderCircuitMetric> {
  const out: Record<string, ProviderCircuitMetric> = {};
  for (const [id, m] of providerCircuitMetrics) {
    out[id] = { ...m };
  }
  return out;
}

export function resetCircuitMetricsForTesting(): void {
  providerCircuitMetrics.clear();
}

export class CircuitBreaker {
  private readonly state = new Map<string, CircuitState>();

  recordFailure(id: string): void {
    const current = this.state.get(id) ?? { failures: 0 };
    current.failures += 1;
    if (current.failures >= K_CIRCUIT_BREAKER_THRESHOLD) {
      const now = Date.now();
      current.openedAt = now;
      markOpen(id, now);
    }
    this.state.set(id, current);
  }

  recordSuccess(id: string): void {
    markRecovery(id, Date.now());
    this.state.delete(id);
  }

  isOpen(id: string): boolean {
    const current = this.state.get(id);
    if (!current?.openedAt) return false;
    if (Date.now() - current.openedAt < K_CIRCUIT_BREAKER_WINDOW_MS) return true;
    current.openedAt = undefined; // 进入半开，允许重试
    this.state.set(id, current);
    return false;
  }
}

const breaker = new CircuitBreaker();

function collectCandidates(registry: Registry, flowState: FlowState, slot: SlotName): ProviderConfig[] {
  const seen = new Set<string>();
  const candidates: ProviderConfig[] = [];
  while (true) {
    const route = selectProvider(registry, slot, flowState, { excludeIds: [...seen] });
    if (!route.ok) break;
    if (seen.has(route.provider.id)) break;
    seen.add(route.provider.id);
    candidates.push(route.provider);
  }
  return candidates;
}

function healthRank(health: ProviderHealth | undefined): number {
  if (!health || health.state === "unknown") return 1;
  if (health.state === "healthy") return 0;
  if (health.state === "degraded") return 2;
  return 3;
}

function isAttemptSuccess(health: ProviderHealth | undefined): boolean {
  if (!health) return true;
  return health.state === "healthy" || health.state === "unknown";
}

function currentHealth(registry: Registry, id: string): ProviderHealth | undefined {
  const health = registry.health(id);
  if (!health || typeof health !== "object") return undefined;
  return "state" in health ? (health as ProviderHealth) : undefined;
}

export async function selectWithFallback(
  registry: Registry,
  flowState: FlowState,
  slot: SlotName,
  options: { skipBreaker?: boolean } = {},
): Promise<FallbackResult> {
  const started = Date.now();
  const candidates = collectCandidates(registry, flowState, slot);
  if (candidates.length === 0) {
    recordDecision({
      ts: Date.now(),
      flowState,
      slot,
      selectedProvider: "none",
      attempts: 0,
      fallbackPath: [],
      durationMs: Date.now() - started,
      outcome: "fail_closed",
    });
    throw new Error(K_ROUTER_FAIL_CLOSED_CODE);
  }

  const ranked = candidates
    .map((provider, index) => {
      const health = currentHealth(registry, provider.id);
      const open = options.skipBreaker !== true && breaker.isOpen(provider.id);
      return { provider, index, health, open };
    })
    .sort((a, b) => {
      if (a.open !== b.open) return a.open ? 1 : -1;
      const deltaHealth = healthRank(a.health) - healthRank(b.health);
      if (deltaHealth !== 0) return deltaHealth;
      return a.index - b.index;
    });

  const fallbackPath: string[] = [];
  let attempts = 0;
  let onlyOpenSkipped = true;

  for (const item of ranked) {
    if (attempts >= K_FALLBACK_MAX_RETRIES) break;
    if (item.open) continue;

    onlyOpenSkipped = false;
    attempts += 1;
    fallbackPath.push(item.provider.id);

    if (isAttemptSuccess(item.health)) {
      breaker.recordSuccess(item.provider.id);
      const durationMs = Date.now() - started;
      recordDecision({
        ts: Date.now(),
        flowState,
        slot,
        selectedProvider: item.provider.id,
        attempts,
        fallbackPath,
        durationMs,
        outcome: "success",
      });
      return {
        provider: item.provider,
        attempts,
        fallbackPath,
        durationMs,
      };
    }

    breaker.recordFailure(item.provider.id);
  }

  const durationMs = Date.now() - started;
  recordDecision({
    ts: Date.now(),
    flowState,
    slot,
    selectedProvider: "none",
    attempts,
    fallbackPath,
    durationMs,
    outcome: onlyOpenSkipped ? "circuit_open" : "fail_closed",
  });
  throw new Error(K_ROUTER_FAIL_CLOSED_CODE);
}
