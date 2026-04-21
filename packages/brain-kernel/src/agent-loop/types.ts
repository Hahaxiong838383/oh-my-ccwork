import type { FlowState } from "@evodesk/shared";
import type { SlotName } from "../providers/registry";

export const AGENT_STAGES = ["preflight", "route", "retrieve", "extract", "verify", "commit"] as const;

export type Stage = (typeof AGENT_STAGES)[number];

export type AgentRunInput = {
  readonly run_id?: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly slot?: SlotName;
  readonly flow_state?: FlowState;
  readonly payload?: unknown;
};

export type AgentContext = {
  readonly run_id: string;
  readonly user_id: string;
  readonly session_id: string;
  readonly fork_depth: number;
  readonly parent_run_id?: string;
  readonly started_at: number;
};

export type PreflightStageOutput = {
  readonly ok: true;
  readonly ctx: AgentContext;
};

export type RouteStageOutput = {
  readonly provider_id: string;
  readonly slot: SlotName;
  readonly fallback_used: boolean;
};

export type RetrieveStageOutput = {
  readonly candidates: readonly unknown[];
};

export type ExtractStageOutput = {
  readonly extracted: readonly unknown[];
};

export type VerifyStageOutput = {
  readonly verified: boolean;
};

export type CommitStageOutput = {
  readonly commit_id: string;
  readonly written: number;
};

export type StageOutputs = {
  preflight: PreflightStageOutput;
  route: RouteStageOutput;
  retrieve: RetrieveStageOutput;
  extract: ExtractStageOutput;
  verify: VerifyStageOutput;
  commit: CommitStageOutput;
};

export type StageResult = {
  readonly stage: Stage;
  readonly ok: boolean;
  readonly duration_ms: number;
  readonly error_code?: string;
};

export type AgentRunOutput = {
  readonly ok: boolean;
  readonly run_id: string;
  readonly terminated_at_stage?: Stage;
  readonly stage_results: readonly StageResult[];
  readonly outputs: Partial<StageOutputs>;
};

export type AgentStageEnterEvent = {
  readonly type: "agent.stage.enter";
  readonly run_id: string;
  readonly stage: Stage;
  readonly fork_depth: number;
  readonly ts: number;
};

export type AgentStageExitEvent = {
  readonly type: "agent.stage.exit";
  readonly run_id: string;
  readonly stage: Stage;
  readonly ok: boolean;
  readonly duration_ms: number;
  readonly fork_depth: number;
  readonly ts: number;
};

export type AgentStageFailEvent = {
  readonly type: "agent.stage.fail";
  readonly run_id: string;
  readonly stage: Stage;
  readonly error_code: string;
  readonly ts: number;
};

export type AgentForkStartEvent = {
  readonly type: "agent.fork.start";
  readonly run_id: string;
  readonly parent_run_id: string;
  readonly fork_depth: number;
  readonly ts: number;
};

export type AgentForkEndEvent = {
  readonly type: "agent.fork.end";
  readonly run_id: string;
  readonly parent_run_id: string;
  readonly fork_depth: number;
  readonly ok: boolean;
  readonly ts: number;
};

export type AgentRejectedEvent = {
  readonly type: "rejected";
  readonly run_id: string;
  readonly stage: "verify";
  readonly ts: number;
};

export type AgentCommitFailedEvent = {
  readonly type: "commit_failed";
  readonly run_id: string;
  readonly stage: "commit";
  readonly ts: number;
};

export type AgentEvent =
  | AgentStageEnterEvent
  | AgentStageExitEvent
  | AgentStageFailEvent
  | AgentForkStartEvent
  | AgentForkEndEvent
  | AgentRejectedEvent
  | AgentCommitFailedEvent;

export type AgentStageHandlers = {
  readonly preflight: (
    input: AgentRunInput,
    ctx: AgentContext,
  ) => PreflightStageOutput | Promise<PreflightStageOutput>;
  readonly route: (
    ctx: AgentContext,
    slot: SlotName,
    flowState: FlowState,
  ) => RouteStageOutput | Promise<RouteStageOutput>;
  readonly retrieve: (
    ctx: AgentContext,
    route: RouteStageOutput,
  ) => RetrieveStageOutput | Promise<RetrieveStageOutput>;
  readonly extract: (
    ctx: AgentContext,
    retrieve: RetrieveStageOutput,
  ) => ExtractStageOutput | Promise<ExtractStageOutput>;
  readonly verify: (
    ctx: AgentContext,
    extract: ExtractStageOutput,
  ) => VerifyStageOutput | Promise<VerifyStageOutput>;
  readonly commit: (
    ctx: AgentContext,
    extract: ExtractStageOutput,
  ) => CommitStageOutput | Promise<CommitStageOutput>;
};
