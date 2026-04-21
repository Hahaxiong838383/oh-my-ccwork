import test from "node:test";
import assert from "node:assert/strict";
import type { FlowState } from "@evodesk/shared";
import type { SlotName } from "../providers/registry";
import {
  clearTelemetry,
  getDecisionStats,
  getRecentDecisions,
  recordDecision,
} from "../providers/telemetry";

function event(overrides: Partial<{
  ts: number;
  flowState: FlowState;
  slot: SlotName;
  selectedProvider: string;
  fallbackPath: string[];
  attempts: number;
  durationMs: number;
  outcome: "success" | "fail_closed" | "circuit_open";
}> = {}) {
  return {
    ts: overrides.ts ?? Date.now(),
    flowState: overrides.flowState ?? "FLOW",
    slot: overrides.slot ?? "chat",
    selectedProvider: overrides.selectedProvider ?? "provider-a",
    fallbackPath: overrides.fallbackPath,
    attempts: overrides.attempts,
    durationMs: overrides.durationMs ?? 12,
    outcome: overrides.outcome ?? "success",
  } as const;
}

test("recordDecision 后可通过 getRecentDecisions 读取", () => {
  clearTelemetry();
  recordDecision(event({ selectedProvider: "p-1" }));
  const items = getRecentDecisions();
  assert.equal(items.length, 1);
  assert.equal(items[0].selectedProvider, "p-1");
});

test("fail_closed 记录包含 attempts + fallbackPath", () => {
  clearTelemetry();
  recordDecision(event({
    outcome: "fail_closed",
    selectedProvider: "none",
    attempts: 3,
    fallbackPath: ["a", "b", "c"],
  }));
  const latest = getRecentDecisions(1)[0];
  assert.equal(latest.outcome, "fail_closed");
  assert.equal(latest.attempts, 3);
  assert.deepEqual(latest.fallbackPath, ["a", "b", "c"]);
});

test("支持 circuit_open outcome", () => {
  clearTelemetry();
  recordDecision(event({
    outcome: "circuit_open",
    selectedProvider: "none",
    attempts: 0,
    fallbackPath: [],
  }));
  const latest = getRecentDecisions(1)[0];
  assert.equal(latest.outcome, "circuit_open");
});

test("getRecentDecisions 默认 limit=100，且支持自定义 limit", () => {
  clearTelemetry();
  for (let i = 0; i < 150; i += 1) {
    recordDecision(event({ selectedProvider: `p-${i}` }));
  }

  assert.equal(getRecentDecisions().length, 100);
  assert.equal(getRecentDecisions(10).length, 10);
  assert.equal(getRecentDecisions(10)[0].selectedProvider, "p-140");
});

test("getDecisionStats 计算 fallbackRate / failClosedRate 正确", () => {
  clearTelemetry();
  recordDecision(event({ flowState: "FLOW", outcome: "success", fallbackPath: ["a"] }));
  recordDecision(event({ flowState: "FLOW", outcome: "success", fallbackPath: ["a", "b"] }));
  recordDecision(event({ flowState: "ANXIETY", outcome: "fail_closed", selectedProvider: "none" }));
  recordDecision(event({ flowState: "APATHY", outcome: "circuit_open", selectedProvider: "none" }));

  const stats = getDecisionStats();
  assert.equal(stats.perFlow.FLOW.total, 2);
  assert.equal(stats.perFlow.FLOW.success, 2);
  assert.equal(stats.perFlow.FLOW.failed, 0);
  assert.equal(stats.perFlow.ANXIETY.total, 1);
  assert.equal(stats.perFlow.ANXIETY.failed, 1);
  assert.equal(stats.perFlow.APATHY.total, 1);
  assert.equal(stats.perFlow.APATHY.failed, 1);
  assert.equal(stats.perFlow.BOREDOM.total, 0);
  assert.equal(stats.fallbackRate, 0.25);
  assert.equal(stats.failClosedRate, 0.25);
});

test(">10K 记录自动 trim 到 10K", () => {
  clearTelemetry();
  for (let i = 0; i < 10_050; i += 1) {
    recordDecision(event({ selectedProvider: `p-${i}` }));
  }
  const all = getRecentDecisions(20_000);
  assert.equal(all.length, 10_000);
  assert.equal(all[0].selectedProvider, "p-50");
  assert.equal(all[all.length - 1].selectedProvider, "p-10049");
});

test("trim 后 getDecisionStats 语义与 buffer 一致", () => {
  clearTelemetry();
  for (let i = 0; i < 5000; i += 1) {
    recordDecision(event({ flowState: "FLOW", outcome: "success" }));
  }
  for (let i = 0; i < 10_000; i += 1) {
    recordDecision(event({ flowState: "APATHY", outcome: "fail_closed", selectedProvider: "none" }));
  }
  const stats = getDecisionStats();
  assert.equal(stats.perFlow.FLOW.total, 0);
  assert.equal(stats.perFlow.APATHY.total, 10_000);
  assert.equal(stats.failClosedRate, 1);
});

test("getDecisionStats O(1) — 10K 后耗时 < 1ms", () => {
  clearTelemetry();
  for (let i = 0; i < 10_000; i += 1) {
    recordDecision(event({ flowState: "FLOW", outcome: "success" }));
  }
  const t0 = performance.now();
  for (let j = 0; j < 1000; j += 1) {
    getDecisionStats();
  }
  const avg = (performance.now() - t0) / 1000;
  assert.ok(avg < 1, `getDecisionStats avg ${avg}ms not < 1ms (O(1) 应 sub-ms)`);
});

test("clearTelemetry 后 counters 归零", () => {
  for (let i = 0; i < 100; i += 1) {
    recordDecision(event({ flowState: "FLOW", outcome: "fail_closed", fallbackPath: ["a", "b"] }));
  }
  clearTelemetry();
  const stats = getDecisionStats();
  assert.equal(stats.perFlow.FLOW.total, 0);
  assert.equal(stats.fallbackRate, 0);
  assert.equal(stats.failClosedRate, 0);
});
