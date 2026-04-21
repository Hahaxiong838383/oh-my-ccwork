import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig, ProbeResult } from "../providers/registry";
import { Registry } from "../providers/registry";
import {
  K_CIRCUIT_BREAKER_THRESHOLD,
  K_CIRCUIT_BREAKER_WINDOW_MS,
  K_FALLBACK_MAX_RETRIES,
  selectWithFallback,
} from "../providers/fallback-chain";
import { K_ROUTER_FAIL_CLOSED_CODE } from "../providers/router";
import { clearTelemetry, getRecentDecisions } from "../providers/telemetry";

type HealthPreset = "healthy" | "degraded";

type ProviderOverride = Partial<ProviderConfig> & { id: string };

function provider(overrides: ProviderOverride): Record<string, unknown> {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "openai",
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 100,
    capabilities: {
      chat: { enabled: true, input: "text", output: "text" },
      extract: { enabled: true, input: "text", output: "json" },
      embed: { enabled: true, input: "text", output: "embedding" },
      vision: { enabled: true, input: "image", output: "text" },
      tool_use: { enabled: true, input: "text", output: "json" },
      ...(overrides.capabilities ?? {}),
    },
    models: overrides.models ?? ["m-test"],
    cost: overrides.cost ?? { input_per_1k: 0.01, output_per_1k: 0.03, currency: "USD" },
    latency_p95: overrides.latency_p95 ?? 1200,
    auth_env: overrides.auth_env ?? ["DUMMY"],
    timeout_ms: overrides.timeout_ms ?? 1200,
    tags: overrides.tags ?? [],
  };
}

function toProbe(state: HealthPreset): ProbeResult {
  if (state === "healthy") return { ok: true, latencyMs: 10 };
  return { ok: false, latencyMs: 10, message: "degraded" };
}

async function buildRegistry(
  items: ProviderOverride[],
  initial: Record<string, HealthPreset>,
): Promise<{ registry: Registry; setHealth: (id: string, state: HealthPreset) => Promise<void> }> {
  const health = new Map<string, HealthPreset>(Object.entries(initial));
  const registry = new Registry({
    probeFn: async (p) => toProbe(health.get(p.id) ?? "healthy"),
    probeTimeoutMs: 500,
  });
  for (const item of items) {
    await registry.register(provider(item));
  }
  return {
    registry,
    setHealth: async (id, state) => {
      health.set(id, state);
      await registry.probe(id);
    },
  };
}

async function expectNoCandidate(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    return error instanceof Error && error.message === K_ROUTER_FAIL_CLOSED_CODE;
  });
}

test("fallback: 主 provider 健康时一次命中", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [{ id: "flow-main-a", priority: 10 }, { id: "flow-main-b", priority: 1000 }],
    { "flow-main-a": "healthy", "flow-main-b": "healthy" },
  );

  const result = await selectWithFallback(registry, "FLOW", "chat");
  assert.equal(result.provider.id, "flow-main-a");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.fallbackPath, ["flow-main-a"]);
});

test("fallback: 主 provider 降级时切换到健康候选", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [{ id: "flow-degraded-a", priority: 10 }, { id: "flow-degraded-b", priority: 20 }],
    { "flow-degraded-a": "degraded", "flow-degraded-b": "healthy" },
  );

  const result = await selectWithFallback(registry, "FLOW", "chat");
  assert.equal(result.provider.id, "flow-degraded-b");
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.fallbackPath, ["flow-degraded-b"]);
});

test("fallback: 全部降级时 fail-closed", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [{ id: "all-bad-a", priority: 10 }, { id: "all-bad-b", priority: 20 }],
    { "all-bad-a": "degraded", "all-bad-b": "degraded" },
  );

  await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
});

test("circuit: 连续失败达到阈值后进入 open", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [{ id: "cb-open-a", priority: 10 }],
    { "cb-open-a": "degraded" },
  );

  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
    await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
  }

  await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
  const latest = getRecentDecisions(1)[0];
  assert.equal(latest.outcome, "circuit_open");
  assert.equal(latest.attempts, 0);
});

test("circuit: open 窗口过后半开恢复可重试", async () => {
  clearTelemetry();
  const { registry, setHealth } = await buildRegistry(
    [{ id: "cb-recover-a", priority: 10 }],
    { "cb-recover-a": "degraded" },
  );

  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
    await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
  }

  await setHealth("cb-recover-a", "healthy");

  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + K_CIRCUIT_BREAKER_WINDOW_MS + 1;
  try {
    const result = await selectWithFallback(registry, "FLOW", "chat");
    assert.equal(result.provider.id, "cb-recover-a");
    assert.equal(result.attempts, 1);
  } finally {
    Date.now = realNow;
  }
});

test("circuit: 成功后 reset，后续失败不会保持 open", async () => {
  clearTelemetry();
  const { registry, setHealth } = await buildRegistry(
    [{ id: "cb-reset-a", priority: 10 }],
    { "cb-reset-a": "degraded" },
  );

  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
    await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
  }

  await setHealth("cb-reset-a", "healthy");
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base + K_CIRCUIT_BREAKER_WINDOW_MS + 1;
  try {
    const recovered = await selectWithFallback(registry, "FLOW", "chat");
    assert.equal(recovered.provider.id, "cb-reset-a");
  } finally {
    Date.now = realNow;
  }

  await setHealth("cb-reset-a", "degraded");
  await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
  const latest = getRecentDecisions(1)[0];
  assert.equal(latest.outcome, "fail_closed");
  assert.equal(latest.attempts, 1);
});

test("策略: quality（FLOW.chat）优先低 priority 候选", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [{ id: "q-high", priority: 5 }, { id: "q-low", priority: 9000 }],
    { "q-high": "healthy", "q-low": "healthy" },
  );

  const result = await selectWithFallback(registry, "FLOW", "chat");
  assert.equal(result.provider.id, "q-high");
});

test("策略: balanced（BOREDOM.chat）会权衡成本与延迟", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [
      {
        id: "b-quality-heavy",
        priority: 10,
        cost: { input_per_1k: 1, output_per_1k: 1, currency: "USD" },
        latency_p95: 1500,
      },
      {
        id: "b-balanced-win",
        priority: 5000,
        cost: { input_per_1k: 0, output_per_1k: 0, currency: "USD" },
        latency_p95: 800,
      },
    ],
    { "b-quality-heavy": "healthy", "b-balanced-win": "healthy" },
  );

  const result = await selectWithFallback(registry, "BOREDOM", "chat");
  assert.equal(result.provider.id, "b-balanced-win");
});

test("策略: availability（ANXIETY.embed）优先可用性", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [
      { id: "a-sick-fast", priority: 10, latency_p95: 100 },
      { id: "a-healthy-slow", priority: 5000, latency_p95: 4000 },
    ],
    { "a-sick-fast": "degraded", "a-healthy-slow": "healthy" },
  );

  const result = await selectWithFallback(registry, "ANXIETY", "embed");
  assert.equal(result.provider.id, "a-healthy-slow");
});

test("策略: local_first（APATHY.chat）优先本地 provider", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [
      { id: "l-cloud", kind: "openai", priority: 10 },
      { id: "l-local", kind: "local", priority: 1000 },
    ],
    { "l-cloud": "healthy", "l-local": "healthy" },
  );

  const result = await selectWithFallback(registry, "APATHY", "chat");
  assert.equal(result.provider.id, "l-local");
});

test("状态集成: APATHY.chat 无 local 时降级到 balanced", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [
      {
        id: "ap-cloud-1",
        priority: 20,
        cost: { input_per_1k: 0.8, output_per_1k: 0.8, currency: "USD" },
      },
      {
        id: "ap-cloud-2",
        priority: 3000,
        cost: { input_per_1k: 0.0, output_per_1k: 0.0, currency: "USD" },
      },
    ],
    { "ap-cloud-1": "healthy", "ap-cloud-2": "healthy" },
  );

  const result = await selectWithFallback(registry, "APATHY", "chat");
  assert.equal(result.provider.id, "ap-cloud-2");
});

test("fallback: retries 上限为 K_FALLBACK_MAX_RETRIES=3", async () => {
  clearTelemetry();
  const { registry } = await buildRegistry(
    [
      { id: "retry-a", priority: 10 },
      { id: "retry-b", priority: 20 },
      { id: "retry-c", priority: 30 },
      { id: "retry-d", priority: 40 },
    ],
    { "retry-a": "degraded", "retry-b": "degraded", "retry-c": "degraded", "retry-d": "degraded" },
  );

  await expectNoCandidate(selectWithFallback(registry, "FLOW", "chat"));
  const latest = getRecentDecisions(1)[0];
  assert.equal(latest.attempts, K_FALLBACK_MAX_RETRIES);
  assert.equal(latest.fallbackPath?.length, K_FALLBACK_MAX_RETRIES);
});
