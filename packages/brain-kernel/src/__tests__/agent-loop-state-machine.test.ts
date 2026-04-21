/**
 * 覆盖契约：6 阶段状态机触发顺序 / route 失败回退到 balanced / 终止条件与事件序列。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AgentContextStore } from "../agent-loop/context-store";
import { AgentLoopEventEmitter } from "../agent-loop/event-emitter";
import { runAgentLoop } from "../agent-loop";
import type { AgentEvent, AgentStageHandlers } from "../agent-loop/types";

function createHarness(overrides: Partial<AgentStageHandlers> = {}) {
  const contextStore = new AgentContextStore();
  const eventEmitter = new AgentLoopEventEmitter();
  const events: AgentEvent[] = [];
  const off = eventEmitter.onAny((event) => events.push(event));

  return {
    contextStore,
    eventEmitter,
    events,
    off,
    handlers: overrides,
  };
}

const INPUT = {
  user_id: "u-1",
  session_id: "s-1",
  slot: "chat" as const,
  flow_state: "FLOW" as const,
};

test("状态机 happy path：6 阶段依序完成 + 12 个 enter/exit 事件", async () => {
  const h = createHarness();
  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, true);
  assert.equal(out.stage_results.length, 6);
  assert.deepEqual(
    out.stage_results.map((x) => x.stage),
    ["preflight", "route", "retrieve", "extract", "verify", "commit"],
  );

  const enters = h.events.filter((x) => x.type === "agent.stage.enter");
  const exits = h.events.filter((x) => x.type === "agent.stage.exit");
  assert.equal(enters.length, 6);
  assert.equal(exits.length, 6);
});

test("preflight 失败：直接 terminate，不进入 route", async () => {
  const h = createHarness({
    preflight: async () => {
      throw new Error("PREFLIGHT_DENY");
    },
  });

  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, false);
  assert.equal(out.terminated_at_stage, "preflight");
  assert.deepEqual(out.stage_results.map((x) => x.stage), ["preflight"]);
  assert.equal(h.events.some((x) => x.type === "agent.stage.enter" && x.stage === "route"), false);
});

test("route 主路径失败后 fallback 到 BOREDOM 成功", async () => {
  const calls: string[] = [];
  const h = createHarness({
    route: async (_ctx, _slot, flowState) => {
      calls.push(flowState);
      if (flowState === "FLOW") {
        throw new Error("PRIMARY_FAIL");
      }
      return { provider_id: "fallback-provider", slot: "chat", fallback_used: false };
    },
  });

  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, true);
  assert.deepEqual(calls, ["FLOW", "BOREDOM"]);
  assert.equal(out.outputs.route?.provider_id, "fallback-provider");
  assert.equal(out.outputs.route?.fallback_used, true);

  const routeFails = h.events.filter((x) => x.type === "agent.stage.fail" && x.stage === "route");
  assert.equal(routeFails.length, 1);
});

test("route 主+fallback 都失败：terminate 于 route", async () => {
  const h = createHarness({
    route: async () => {
      throw new Error("ROUTE_DOWN");
    },
  });

  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, false);
  assert.equal(out.terminated_at_stage, "route");
  assert.equal(h.events.some((x) => x.type === "agent.stage.enter" && x.stage === "retrieve"), false);

  const routeFails = h.events.filter((x) => x.type === "agent.stage.fail" && x.stage === "route");
  assert.equal(routeFails.length, 2);
});

test("retrieve/extract 失败降级为空数组并继续到 commit", async () => {
  const h = createHarness({
    retrieve: async () => {
      throw new Error("RETRIEVE_OFFLINE");
    },
    extract: async () => {
      throw new Error("EXTRACT_TIMEOUT");
    },
  });

  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, true);
  assert.deepEqual(out.outputs.retrieve?.candidates, []);
  assert.deepEqual(out.outputs.extract?.extracted, []);

  const retrieveResult = out.stage_results.find((x) => x.stage === "retrieve");
  const extractResult = out.stage_results.find((x) => x.stage === "extract");
  assert.equal(retrieveResult?.ok, false);
  assert.equal(extractResult?.ok, false);
});

test("verify 返回 false：发 rejected 事件并 terminate，不进入 commit", async () => {
  const h = createHarness({
    verify: async () => ({ verified: false }),
  });

  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, false);
  assert.equal(out.terminated_at_stage, "verify");
  assert.equal(h.events.some((x) => x.type === "rejected"), true);
  assert.equal(h.events.some((x) => x.type === "agent.stage.enter" && x.stage === "commit"), false);
});

test("commit 抛错：发 commit_failed 事件并 terminate", async () => {
  const h = createHarness({
    commit: async () => {
      throw new Error("COMMIT_IO_ERR");
    },
  });

  const out = await runAgentLoop(INPUT, h);
  h.off();

  assert.equal(out.ok, false);
  assert.equal(out.terminated_at_stage, "commit");
  assert.equal(h.events.some((x) => x.type === "commit_failed"), true);

  const commitResult = out.stage_results.find((x) => x.stage === "commit");
  assert.equal(commitResult?.ok, false);
  assert.equal(commitResult?.error_code, "COMMIT_IO_ERR");
});

test("BOREDOM flow_state + route 首次成功：fallback_used 应为 false", async () => {
  const h = createHarness({
    route: async (_ctx, slot, _flowState) => ({
      provider_id: "boredom-provider",
      slot,
      fallback_used: false,
    }),
  });

  const out = await runAgentLoop({ ...INPUT, flow_state: "BOREDOM" }, h);
  h.off();

  assert.equal(out.ok, true);
  assert.equal(out.outputs.route?.fallback_used, false);
  assert.equal(out.outputs.route?.provider_id, "boredom-provider");
});
