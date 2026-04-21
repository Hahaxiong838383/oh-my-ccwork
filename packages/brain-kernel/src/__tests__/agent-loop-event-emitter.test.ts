/**
 * 覆盖契约：事件序列正确性、订阅机制、取消订阅清理（含 fork/rejected/commit_failed）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoopEventEmitter } from "../agent-loop/event-emitter";
import type { AgentContext, AgentEvent } from "../agent-loop/types";

const CTX: AgentContext = {
  run_id: "run-e",
  user_id: "u-e",
  session_id: "s-e",
  fork_depth: 0,
  started_at: 10,
};

test("stage enter/fail/exit 事件序列正确", () => {
  const emitter = new AgentLoopEventEmitter();
  const events: AgentEvent[] = [];
  const off = emitter.onAny((e) => events.push(e));

  emitter.emitStageEnter(CTX, "route", 100);
  emitter.emitStageFail(CTX, "route", "NO_CANDIDATE", 101);
  emitter.emitStageExit(CTX, "route", false, 9, 109);
  off();

  assert.deepEqual(events.map((e) => e.type), ["agent.stage.enter", "agent.stage.fail", "agent.stage.exit"]);

  const exit = events[2];
  assert.equal(exit.type, "agent.stage.exit");
  if (exit.type === "agent.stage.exit") {
    assert.equal(exit.duration_ms, 9);
    assert.equal(exit.ok, false);
  }
});

test("可按事件类型订阅（on）", () => {
  const emitter = new AgentLoopEventEmitter();
  const seen: string[] = [];
  const offEnter = emitter.on("agent.stage.enter", () => seen.push("enter"));
  const offCommitFailed = emitter.on("commit_failed", () => seen.push("commit_failed"));

  emitter.emitStageEnter(CTX, "commit", 200);
  emitter.emitCommitFailed(CTX, 210);
  emitter.emitRejected(CTX, 220);

  offEnter();
  offCommitFailed();

  assert.deepEqual(seen, ["enter", "commit_failed"]);
});

test("取消订阅后不再接收事件", () => {
  const emitter = new AgentLoopEventEmitter();
  let count = 0;
  const off = emitter.onAny(() => {
    count += 1;
  });

  emitter.emitStageEnter(CTX, "preflight", 1);
  off();
  emitter.emitStageExit(CTX, "preflight", true, 2, 3);

  assert.equal(count, 1);
});

test("fork.start/fork.end 事件携带 parent_run_id", () => {
  const emitter = new AgentLoopEventEmitter();
  const events: AgentEvent[] = [];
  const off = emitter.onAny((event) => events.push(event));

  const child: AgentContext = {
    ...CTX,
    run_id: "run-child",
    parent_run_id: "run-e",
    fork_depth: 1,
  };

  emitter.emitForkStart(CTX, child, 300);
  emitter.emitForkEnd(CTX, child, true, 310);
  off();

  const start = events[0];
  const end = events[1];
  assert.equal(start.type, "agent.fork.start");
  assert.equal(end.type, "agent.fork.end");

  if (start.type === "agent.fork.start") {
    assert.equal(start.parent_run_id, "run-e");
  }
  if (end.type === "agent.fork.end") {
    assert.equal(end.ok, true);
    assert.equal(end.parent_run_id, "run-e");
  }
});
