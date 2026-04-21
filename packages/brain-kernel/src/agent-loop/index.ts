import { AgentContextStore, defaultAgentContextStore } from "./context-store";
import { AgentLoopEventEmitter, defaultAgentEventEmitter } from "./event-emitter";
import { runAgentStateMachine } from "./state-machine";
import type { AgentContext, AgentRunInput, AgentRunOutput, AgentStageHandlers } from "./types";

function nowMs(): number {
  return Date.now();
}

export type RunAgentLoopOptions = {
  readonly contextStore?: AgentContextStore;
  readonly eventEmitter?: AgentLoopEventEmitter;
  readonly handlers?: Partial<AgentStageHandlers>;
  readonly now?: () => number;
};

export async function runAgentLoop(input: AgentRunInput, options: RunAgentLoopOptions = {}): Promise<AgentRunOutput> {
  const contextStore = options.contextStore ?? defaultAgentContextStore;
  const eventEmitter = options.eventEmitter ?? defaultAgentEventEmitter;
  const now = options.now ?? nowMs;

  const rootContext = contextStore.createRootContext(input, now);

  return contextStore.runWithContext(rootContext, async () => {
    return runAgentStateMachine(input, rootContext, {
      handlers: options.handlers,
      eventEmitter,
      now,
    });
  });
}

export async function forkAgentLoop<T>(
  fn: () => T | Promise<T>,
  options: Pick<RunAgentLoopOptions, "contextStore" | "eventEmitter" | "now"> = {},
): Promise<T> {
  const contextStore = options.contextStore ?? defaultAgentContextStore;
  const eventEmitter = options.eventEmitter ?? defaultAgentEventEmitter;
  const now = options.now ?? nowMs;

  return contextStore.fork(fn, {
    onForkStart(parent: AgentContext, child: AgentContext) {
      eventEmitter.emitForkStart(parent, child, now());
    },
    onForkEnd(parent: AgentContext, child: AgentContext, ok: boolean) {
      eventEmitter.emitForkEnd(parent, child, ok, now());
    },
  }, now);
}

export * from "./types";
export * from "./context-store";
export * from "./event-emitter";
export * from "./state-machine";
