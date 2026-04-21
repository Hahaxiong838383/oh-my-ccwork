import test from "node:test";
import assert from "node:assert/strict";
import {
  CircuitBreaker,
  K_CIRCUIT_BREAKER_THRESHOLD,
  getCircuitMetrics,
  resetCircuitMetricsForTesting,
} from "../providers/fallback-chain";

test("CircuitBreaker metrics — 首次 open 累计 openCount + 写入 lastOpenedAt", () => {
  resetCircuitMetricsForTesting();
  const breaker = new CircuitBreaker();
  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i++) breaker.recordFailure("p1");
  const m = getCircuitMetrics();
  assert.equal(m.p1.openCount, 1);
  assert.ok(m.p1.lastOpenedAt && m.p1.lastOpenedAt > 0);
  assert.ok(m.p1.currentlyOpenSince && m.p1.currentlyOpenSince > 0);
  assert.equal(m.p1.recoveryCount, 0);
});

test("CircuitBreaker metrics — recordSuccess 记录恢复耗时", async () => {
  resetCircuitMetricsForTesting();
  const breaker = new CircuitBreaker();
  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i++) breaker.recordFailure("p2");
  await new Promise((r) => setTimeout(r, 15));
  breaker.recordSuccess("p2");
  const m = getCircuitMetrics();
  assert.equal(m.p2.recoveryCount, 1);
  assert.ok((m.p2.lastRecoveryMs ?? 0) >= 10, "lastRecoveryMs 应 ≥10ms");
  assert.equal(m.p2.currentlyOpenSince, undefined, "恢复后 currentlyOpenSince 清空");
});

test("CircuitBreaker metrics — 同一次 open 期内 recordFailure 不重算 openCount", () => {
  resetCircuitMetricsForTesting();
  const breaker = new CircuitBreaker();
  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i++) breaker.recordFailure("p3");
  breaker.recordFailure("p3");
  breaker.recordFailure("p3");
  const m = getCircuitMetrics();
  assert.equal(m.p3.openCount, 1, "同一次 open 期内不重算");
});

test("CircuitBreaker metrics — 恢复后再 open 算新一轮", async () => {
  resetCircuitMetricsForTesting();
  const breaker = new CircuitBreaker();
  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i++) breaker.recordFailure("p4");
  breaker.recordSuccess("p4");
  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i++) breaker.recordFailure("p4");
  const m = getCircuitMetrics();
  assert.equal(m.p4.openCount, 2, "恢复后再次 open 应累计");
  assert.equal(m.p4.recoveryCount, 1);
});

test("getCircuitMetrics — 返回快照不泄漏内部引用", () => {
  resetCircuitMetricsForTesting();
  const breaker = new CircuitBreaker();
  for (let i = 0; i < K_CIRCUIT_BREAKER_THRESHOLD; i++) breaker.recordFailure("p5");
  const snapshot1 = getCircuitMetrics();
  snapshot1.p5.openCount = 999;
  const snapshot2 = getCircuitMetrics();
  assert.equal(snapshot2.p5.openCount, 1, "内部状态不受外部修改影响");
});
