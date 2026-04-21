import test from "node:test";
import assert from "node:assert/strict";
import type { FlowState } from "@evodesk/shared";
import { Registry, type ProbeResult, type ProviderConfig, type SlotName } from "../providers/registry";
import {
  FLOW_POLICY,
  K_ROUTER_FAIL_CLOSED_CODE,
  K_ROUTER_FLOW_STATES,
  selectProvider,
  scoreCandidate,
} from "../providers/router";

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
      embed: { enabled: false, input: "text", output: "embedding" },
      vision: { enabled: true, input: "image", output: "text" },
      tool_use: { enabled: true, input: "text", output: "json" },
      ...(overrides.capabilities ?? {}),
    },
    models: overrides.models ?? ["m-mini"],
    cost: overrides.cost ?? { input_per_1k: 0.01, output_per_1k: 0.03, currency: "USD" },
    latency_p95: overrides.latency_p95 ?? 1500,
    auth_env: overrides.auth_env ?? ["DUMMY"],
    timeout_ms: overrides.timeout_ms ?? 2000,
    tags: overrides.tags ?? [],
  };
}

async function buildRegistry(
  items: ProviderOverride[],
  probe: (id: string) => ProbeResult = () => ({ ok: true, latencyMs: 10 }),
): Promise<Registry> {
  const registry = new Registry({
    probeFn: async (p) => probe(p.id),
    probeTimeoutMs: 500,
  });
  for (const item of items) {
    await registry.register(provider(item));
  }
  return registry;
}

// ---------- 1. 常量与 policy 完整性 ----------

test("K_ROUTER_FLOW_STATES 覆盖 4 个 FLOW 状态", () => {
  assert.deepEqual([...K_ROUTER_FLOW_STATES].sort(), ["ANXIETY", "APATHY", "BOREDOM", "FLOW"]);
});

test("FLOW_POLICY 完整覆盖 4 状态 × 5 slot = 20 格", () => {
  const slots: SlotName[] = ["chat", "extract", "embed", "vision", "tool_use"];
  for (const flow of K_ROUTER_FLOW_STATES) {
    const perFlow = FLOW_POLICY[flow];
    for (const slot of slots) {
      assert.ok(perFlow[slot], `${flow}.${slot} 必须有 preference`);
    }
  }
});

test("FLOW 状态采用 quality，APATHY 的 vision 兜底为 balanced（gemini 战略建议）", () => {
  assert.equal(FLOW_POLICY.FLOW.chat, "quality");
  assert.equal(FLOW_POLICY.APATHY.vision, "balanced");
  assert.equal(FLOW_POLICY.APATHY.chat, "local_first");
  assert.equal(FLOW_POLICY.ANXIETY.chat, "quality");
});

// ---------- 2. scoreCandidate 四档 ----------

test("scoreCandidate: quality 对 priority 高权（0.5）", () => {
  const p = provider({ id: "p", priority: 0 }) as unknown as ProviderConfig;
  const lowPri = provider({ id: "q", priority: 10_000 }) as unknown as ProviderConfig;
  const healthy = { state: "healthy" as const, lastCheckedAt: "" };
  const sHi = scoreCandidate(p, healthy, "quality");
  const sLo = scoreCandidate(lowPri, healthy, "quality");
  assert.ok(sHi > sLo, "quality 偏好应优先 priority 低（inv 高）");
});

test("scoreCandidate: availability 对 healthy 高权（0.5）", () => {
  const p = provider({ id: "p" }) as unknown as ProviderConfig;
  const healthy = { state: "healthy" as const, lastCheckedAt: "" };
  const unhealthy = { state: "unhealthy" as const, lastCheckedAt: "" };
  assert.ok(
    scoreCandidate(p, healthy, "availability") > scoreCandidate(p, unhealthy, "availability"),
  );
});

test("scoreCandidate: local_first 对 kind=local 高权（0.6）", () => {
  const localP = provider({ id: "l", kind: "local" }) as unknown as ProviderConfig;
  const cloudP = provider({ id: "c", kind: "openai" }) as unknown as ProviderConfig;
  const healthy = { state: "healthy" as const, lastCheckedAt: "" };
  assert.ok(
    scoreCandidate(localP, healthy, "local_first") > scoreCandidate(cloudP, healthy, "local_first"),
    "local_first 应大幅优待本地 provider",
  );
});

test("scoreCandidate: balanced 四维度均参与", () => {
  const p = provider({ id: "p" }) as unknown as ProviderConfig;
  const healthy = { state: "healthy" as const, lastCheckedAt: "" };
  const s = scoreCandidate(p, healthy, "balanced");
  assert.ok(s >= 0 && s <= 1, "balanced 分应落在 [0,1]");
});

// ---------- 3. selectProvider 核心流程 ----------

test("selectProvider: FLOW+chat 挑 quality 最优（低 priority）", async () => {
  const reg = await buildRegistry([
    { id: "hii", priority: 10, cost: { input_per_1k: 0.01, output_per_1k: 0.03, currency: "USD" } },
    { id: "low", priority: 9000, cost: { input_per_1k: 0.001, output_per_1k: 0.003, currency: "USD" } },
  ]);
  const r = selectProvider(reg, "chat", "FLOW");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.provider.id, "hii");
    assert.equal(r.preference, "quality");
    assert.equal(r.fallbackApplied, false);
  }
});

test("selectProvider: APATHY+chat 在有 kind=local 时选 local", async () => {
  const reg = await buildRegistry([
    { id: "cloud-a", kind: "openai", priority: 10 },
    { id: "local-a", kind: "local", priority: 500 },
  ]);
  const r = selectProvider(reg, "chat", "APATHY");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.provider.id, "local-a");
    assert.equal(r.preference, "local_first");
    assert.equal(r.fallbackApplied, false);
  }
});

test("selectProvider: APATHY+chat 在无 local 时降级到 balanced（gemini 建议兜底）", async () => {
  const reg = await buildRegistry([
    { id: "cloud-a", kind: "openai", priority: 10 },
    { id: "cloud-b", kind: "anthropic", priority: 20 },
  ]);
  const r = selectProvider(reg, "chat", "APATHY");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.preference, "balanced");
    assert.equal(r.fallbackApplied, true);
  }
});

test("selectProvider: APATHY+vision 即使只有 cloud provider 也不触发兜底（policy 本就是 balanced）", async () => {
  const reg = await buildRegistry([
    { id: "cloud-a", kind: "openai", priority: 10 },
  ]);
  const r = selectProvider(reg, "vision", "APATHY");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.preference, "balanced");
    assert.equal(r.fallbackApplied, false);
  }
});

test("selectProvider: 无 candidate 返回 fail-closed NO_CANDIDATE", async () => {
  const reg = await buildRegistry([]);
  const r = selectProvider(reg, "chat", "FLOW");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, K_ROUTER_FAIL_CLOSED_CODE);
    assert.match(r.reason, /no_candidate/);
  }
});

test("selectProvider: slot 不支持的 provider 被过滤", async () => {
  const reg = await buildRegistry([
    {
      id: "only-chat",
      capabilities: {
        chat: { enabled: true, input: "text", output: "text" },
        extract: { enabled: false, input: "text", output: "json" },
        embed: { enabled: false, input: "text", output: "embedding" },
        vision: { enabled: false, input: "image", output: "text" },
        tool_use: { enabled: false, input: "text", output: "json" },
      },
    },
  ]);
  const r = selectProvider(reg, "embed", "FLOW");
  assert.equal(r.ok, false);
});

test("selectProvider: excludeIds 生效", async () => {
  const reg = await buildRegistry([
    { id: "aaa", priority: 10 },
    { id: "mid", priority: 200 },
  ]);
  const r = selectProvider(reg, "chat", "FLOW", { excludeIds: ["aaa"] });
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.provider.id, "mid");
});

test("selectProvider: enabled=false 被过滤", async () => {
  const reg = await buildRegistry([
    { id: "aaa-on", priority: 100 },
    { id: "bbb-off", priority: 10, enabled: false },
  ]);
  const r = selectProvider(reg, "chat", "FLOW");
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.provider.id, "aaa-on");
});

test("selectProvider: 非法 flowState 返回 fail-closed", async () => {
  const reg = await buildRegistry([{ id: "aaa" }]);
  const r = selectProvider(reg, "chat", "HAPPY" as FlowState);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /invalid_flow_state/);
});

test("selectProvider: 同分打破 tie 用 priority 再 id 字母序", async () => {
  const reg = await buildRegistry([
    { id: "bbb", priority: 50 },
    { id: "aaa", priority: 50 },
  ]);
  const r = selectProvider(reg, "chat", "FLOW");
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.provider.id, "aaa");
});

test("selectProvider: ANXIETY+chat 偏 quality（gemini 战略建议）", async () => {
  const reg = await buildRegistry([
    { id: "str-a", priority: 10 },
    { id: "weak-a", priority: 9000 },
  ]);
  const r = selectProvider(reg, "chat", "ANXIETY");
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.preference, "quality");
    assert.equal(r.provider.id, "str-a");
  }
});
