import type { FlowState } from "@evodesk/shared";
import type { Registry, SlotName } from "../providers/registry";
import { selectProvider } from "../providers/router";
import type {
  AgentContext,
  AgentRunInput,
  AgentRunOutput,
  AgentStageHandlers,
  CommitStageOutput,
  ExtractStageOutput,
  RetrieveStageOutput,
  RouteStageOutput,
  Stage,
  StageResult,
  VerifyStageOutput,
} from "./types";
import { AgentLoopEventEmitter, defaultAgentEventEmitter } from "./event-emitter";

class StageExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "StageExecutionError";
  }
}

function errorCode(error: unknown, fallbackCode: string): string {
  if (error instanceof StageExecutionError) return error.code;
  if (error instanceof Error && error.message) return error.message;
  return fallbackCode;
}

function nowMs(): number {
  return Date.now();
}

type StateMachineOptions = {
  readonly handlers?: Partial<AgentStageHandlers>;
  readonly eventEmitter?: AgentLoopEventEmitter;
  readonly now?: () => number;
  readonly registry?: Registry;
};

function defaultRouteHandler(registry?: Registry): AgentStageHandlers["route"] {
  return async (_ctx, slot, flowState) => {
    // B15.5/B16 实装：接入真实 registry + telemetry + fallback chain。
    if (!registry) {
      return {
        provider_id: "stub-balanced-provider",
        slot,
        fallback_used: false,
      };
    }

    const result = selectProvider(registry, slot, flowState);
    if (!result.ok) {
      throw new StageExecutionError(result.code, result.reason);
    }

    return {
      provider_id: result.provider.id,
      slot,
      fallback_used: false,
    };
  };
}

function createHandlers(options: StateMachineOptions): AgentStageHandlers {
  const routeHandler = defaultRouteHandler(options.registry);

  return {
    preflight: async (_input, ctx) => {
      if (!ctx.user_id || !ctx.session_id) {
        throw new StageExecutionError("PREFLIGHT_INVALID_CONTEXT");
      }
      return { ok: true, ctx };
    },
    route: routeHandler,
    retrieve: async () => {
      // B15.5/B16 实装：检索层接入真实候选源（RRF / graph / memory）。
      return { candidates: [] };
    },
    extract: async () => {
      // B15.5/B16 实装：接入结构化抽取与 confidence 打分。
      return { extracted: [] };
    },
    verify: async () => {
      // B15.5/B16 实装：接入 verifier agent + 规则校验。
      return { verified: true };
    },
    commit: async (ctx) => {
      // B15.5/B16 实装：接入真实落库（本批次禁止写业务表）。
      return { commit_id: `stub-commit-${ctx.run_id}`, written: 0 };
    },
    ...options.handlers,
  };
}

function pushStageResult(results: StageResult[], stage: Stage, ok: boolean, duration_ms: number, error_code?: string): void {
  results.push({ stage, ok, duration_ms, error_code });
}

function terminate(
  ctx: AgentContext,
  stage: Stage,
  outputs: AgentRunOutput["outputs"],
  stageResults: StageResult[],
): AgentRunOutput {
  return {
    ok: false,
    run_id: ctx.run_id,
    terminated_at_stage: stage,
    stage_results: stageResults,
    outputs,
  };
}

export async function runAgentStateMachine(
  input: AgentRunInput,
  ctx: AgentContext,
  options: StateMachineOptions = {},
): Promise<AgentRunOutput> {
  const handlers = createHandlers(options);
  const emitter = options.eventEmitter ?? defaultAgentEventEmitter;
  const now = options.now ?? nowMs;
  const slot: SlotName = input.slot ?? "chat";
  const initialFlowState: FlowState = input.flow_state ?? "FLOW";

  const stageResults: StageResult[] = [];
  const outputs: AgentRunOutput["outputs"] = {};

  // effective ctx: preflight may return a modified context; use it for all subsequent stages
  let effectiveCtx: AgentContext = ctx;

  // 1) preflight
  {
    const stage: Stage = "preflight";
    const enterTs = now();
    emitter.emitStageEnter(ctx, stage, enterTs);
    try {
      outputs.preflight = await handlers.preflight(input, ctx);
      effectiveCtx = outputs.preflight.ctx;
      const duration = now() - enterTs;
      pushStageResult(stageResults, stage, true, duration);
      emitter.emitStageExit(ctx, stage, true, duration, now());
    } catch (error) {
      const duration = now() - enterTs;
      const code = errorCode(error, "PREFLIGHT_FAILED");
      emitter.emitStageFail(ctx, stage, code, now());
      pushStageResult(stageResults, stage, false, duration, code);
      emitter.emitStageExit(ctx, stage, false, duration, now());
      return terminate(ctx, stage, outputs, stageResults);
    }
  }

  // 2) route（带 balanced 兜底）
  {
    const stage: Stage = "route";
    const enterTs = now();
    emitter.emitStageEnter(effectiveCtx, stage, enterTs);
    let routed = false;

    try {
      outputs.route = await handlers.route(effectiveCtx, slot, initialFlowState);
      routed = true;
    } catch (primaryError) {
      const primaryCode = errorCode(primaryError, "ROUTE_PRIMARY_FAILED");
      emitter.emitStageFail(effectiveCtx, stage, primaryCode, now());

      if (initialFlowState !== "BOREDOM") {
        try {
          const fallback = await handlers.route(effectiveCtx, slot, "BOREDOM");
          outputs.route = {
            ...fallback,
            fallback_used: true,
          };
          routed = true;
        } catch (fallbackError) {
          const fallbackCode = errorCode(fallbackError, "ROUTE_FALLBACK_FAILED");
          emitter.emitStageFail(effectiveCtx, stage, fallbackCode, now());
          const duration = now() - enterTs;
          pushStageResult(stageResults, stage, false, duration, fallbackCode);
          emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
          return terminate(effectiveCtx, stage, outputs, stageResults);
        }
      } else {
        const duration = now() - enterTs;
        pushStageResult(stageResults, stage, false, duration, primaryCode);
        emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
        return terminate(effectiveCtx, stage, outputs, stageResults);
      }
    }

    const duration = now() - enterTs;
    pushStageResult(stageResults, stage, routed, duration, routed ? undefined : "ROUTE_FAILED");
    emitter.emitStageExit(effectiveCtx, stage, routed, duration, now());
    if (!routed) {
      return terminate(effectiveCtx, stage, outputs, stageResults);
    }
  }

  // 3) retrieve（失败降级为空候选继续）
  {
    const stage: Stage = "retrieve";
    const enterTs = now();
    emitter.emitStageEnter(effectiveCtx, stage, enterTs);
    let ok = true;

    try {
      outputs.retrieve = await handlers.retrieve(effectiveCtx, outputs.route as RouteStageOutput);
    } catch (error) {
      ok = false;
      const code = errorCode(error, "RETRIEVE_FAILED");
      emitter.emitStageFail(effectiveCtx, stage, code, now());
      outputs.retrieve = { candidates: [] } satisfies RetrieveStageOutput;
      const duration = now() - enterTs;
      pushStageResult(stageResults, stage, false, duration, code);
      emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
    }

    if (ok) {
      const duration = now() - enterTs;
      pushStageResult(stageResults, stage, true, duration);
      emitter.emitStageExit(effectiveCtx, stage, true, duration, now());
    }
  }

  // 4) extract（失败降级为空 extracted 继续）
  {
    const stage: Stage = "extract";
    const enterTs = now();
    emitter.emitStageEnter(effectiveCtx, stage, enterTs);
    let ok = true;

    try {
      outputs.extract = await handlers.extract(effectiveCtx, outputs.retrieve as RetrieveStageOutput);
    } catch (error) {
      ok = false;
      const code = errorCode(error, "EXTRACT_FAILED");
      emitter.emitStageFail(effectiveCtx, stage, code, now());
      outputs.extract = { extracted: [] } satisfies ExtractStageOutput;
      const duration = now() - enterTs;
      pushStageResult(stageResults, stage, false, duration, code);
      emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
    }

    if (ok) {
      const duration = now() - enterTs;
      pushStageResult(stageResults, stage, true, duration);
      emitter.emitStageExit(effectiveCtx, stage, true, duration, now());
    }
  }

  // 5) verify（verified=false 终止 + rejected 事件）
  {
    const stage: Stage = "verify";
    const enterTs = now();
    emitter.emitStageEnter(effectiveCtx, stage, enterTs);

    try {
      outputs.verify = await handlers.verify(effectiveCtx, outputs.extract as ExtractStageOutput);
    } catch (error) {
      const duration = now() - enterTs;
      const code = errorCode(error, "VERIFY_FAILED");
      emitter.emitStageFail(effectiveCtx, stage, code, now());
      pushStageResult(stageResults, stage, false, duration, code);
      emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
      return terminate(effectiveCtx, stage, outputs, stageResults);
    }

    if (!outputs.verify.verified) {
      const duration = now() - enterTs;
      emitter.emitRejected(effectiveCtx, now());
      pushStageResult(stageResults, stage, false, duration, "VERIFY_REJECTED");
      emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
      return terminate(effectiveCtx, stage, outputs, stageResults);
    }

    const duration = now() - enterTs;
    pushStageResult(stageResults, stage, true, duration);
    emitter.emitStageExit(effectiveCtx, stage, true, duration, now());
  }

  // 6) commit（失败终止 + commit_failed）
  {
    const stage: Stage = "commit";
    const enterTs = now();
    emitter.emitStageEnter(effectiveCtx, stage, enterTs);

    try {
      outputs.commit = await handlers.commit(effectiveCtx, outputs.extract as ExtractStageOutput);
    } catch (error) {
      const duration = now() - enterTs;
      const code = errorCode(error, "COMMIT_FAILED");
      emitter.emitStageFail(effectiveCtx, stage, code, now());
      emitter.emitCommitFailed(effectiveCtx, now());
      pushStageResult(stageResults, stage, false, duration, code);
      emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
      return terminate(effectiveCtx, stage, outputs, stageResults);
    }

    const duration = now() - enterTs;
    // P2d: written=0 表示审计层 DB 写入未实际发生，记录为警告态（ok=false）但不终止流程
    const written = (outputs.commit as CommitStageOutput).written ?? -1;
    if (written === 0) {
      pushStageResult(stageResults, stage, false, duration, 'COMMIT_AUDIT_SKIPPED');
      emitter.emitStageExit(effectiveCtx, stage, false, duration, now());
    } else {
      pushStageResult(stageResults, stage, true, duration);
      emitter.emitStageExit(effectiveCtx, stage, true, duration, now());
    }
  }

  return {
    ok: true,
    run_id: effectiveCtx.run_id,
    stage_results: stageResults,
    outputs,
  };
}

export { StageExecutionError };
