import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AgentContext, AgentRunInput } from "./types";

// [ref: K_AGENT_FORK_MAX @ docs/offline-first-read/constants-truth-table.md]
export const K_AGENT_FORK_MAX = 5;

type ForkHooks = {
  readonly onForkStart?: (parent: AgentContext, child: AgentContext) => void;
  readonly onForkEnd?: (parent: AgentContext, child: AgentContext, ok: boolean) => void;
};

function nowMs(): number {
  return Date.now();
}

export class AgentContextStore {
  private readonly storage = new AsyncLocalStorage<AgentContext>();

  createRootContext(input: AgentRunInput, now: () => number = nowMs): AgentContext {
    return {
      run_id: input.run_id ?? randomUUID(),
      user_id: input.user_id,
      session_id: input.session_id,
      fork_depth: 0,
      started_at: now(),
    };
  }

  runWithContext<T>(context: AgentContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  getContext(): AgentContext | undefined {
    return this.storage.getStore();
  }

  requireContext(): AgentContext {
    const ctx = this.getContext();
    if (!ctx) {
      throw new Error("agent_context_missing");
    }
    return ctx;
  }

  buildForkContext(parent: AgentContext, now: () => number = nowMs): AgentContext {
    if (parent.fork_depth >= K_AGENT_FORK_MAX) {
      throw new Error(`fork_depth_exceeded:${K_AGENT_FORK_MAX}`);
    }

    return {
      run_id: randomUUID(),
      user_id: parent.user_id,
      session_id: parent.session_id,
      fork_depth: parent.fork_depth + 1,
      parent_run_id: parent.run_id,
      started_at: now(),
    };
  }

  async fork<T>(
    fn: () => T | Promise<T>,
    hooks: ForkHooks = {},
    now: () => number = nowMs,
  ): Promise<T> {
    const parent = this.requireContext();
    const child = this.buildForkContext(parent, now);
    hooks.onForkStart?.(parent, child);

    try {
      const result = await this.runWithContext(child, fn);
      hooks.onForkEnd?.(parent, child, true);
      return result;
    } catch (error) {
      hooks.onForkEnd?.(parent, child, false);
      throw error;
    }
  }
}

export const defaultAgentContextStore = new AgentContextStore();
