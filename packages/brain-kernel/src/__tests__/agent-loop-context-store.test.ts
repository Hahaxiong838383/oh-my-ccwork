/**
 * 覆盖契约：AsyncLocalStorage fork 隔离、父子继承关系、fork_depth 上限控制。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AgentContextStore, K_AGENT_FORK_MAX } from "../agent-loop/context-store";

const ROOT_INPUT = {
  run_id: "run-root",
  user_id: "u-ctx",
  session_id: "s-ctx",
};

test("fork 继承 user/session，且 parent_run_id 指向父 run", async () => {
  const store = new AgentContextStore();
  const root = store.createRootContext(ROOT_INPUT, () => 1000);

  const snapshot = await store.runWithContext(root, async () => {
    return store.fork(async () => {
      const child = store.requireContext();
      const parent = root;
      return { child, parent };
    }, {}, () => 2000);
  });

  assert.equal(snapshot.parent.run_id, "run-root");
  assert.equal(snapshot.child.user_id, snapshot.parent.user_id);
  assert.equal(snapshot.child.session_id, snapshot.parent.session_id);
  assert.equal(snapshot.child.parent_run_id, snapshot.parent.run_id);
  assert.equal(snapshot.child.fork_depth, snapshot.parent.fork_depth + 1);
  assert.equal(snapshot.parent.fork_depth, 0);
});

test("并发 fork 相互隔离，不污染父上下文", async () => {
  const store = new AgentContextStore();
  const root = store.createRootContext(ROOT_INPUT, () => 3000);

  const result = await store.runWithContext(root, async () => {
    const [a, b] = await Promise.all([
      store.fork(async () => store.requireContext().run_id, {}, () => 4000),
      store.fork(async () => store.requireContext().run_id, {}, () => 5000),
    ]);

    return {
      childA: a,
      childB: b,
      parent: store.requireContext().run_id,
      depth: store.requireContext().fork_depth,
    };
  });

  assert.notEqual(result.childA, result.childB);
  assert.equal(result.parent, "run-root");
  assert.equal(result.depth, 0);
});

test("fork_depth 达上限时报错", async () => {
  const store = new AgentContextStore();
  const root = store.createRootContext(ROOT_INPUT, () => 6000);

  const reachLimit = async (): Promise<number> => {
    if (store.requireContext().fork_depth === K_AGENT_FORK_MAX) {
      return store.requireContext().fork_depth;
    }
    return store.fork(reachLimit);
  };

  const exceedLimit = async (): Promise<void> => {
    if (store.requireContext().fork_depth === K_AGENT_FORK_MAX) {
      await store.fork(async () => undefined);
      return;
    }
    await store.fork(exceedLimit);
  };

  const maxDepth = await store.runWithContext(root, reachLimit);
  assert.equal(maxDepth, K_AGENT_FORK_MAX);

  await assert.rejects(
    store.runWithContext(root, exceedLimit),
    /fork_depth_exceeded/,
  );
});
