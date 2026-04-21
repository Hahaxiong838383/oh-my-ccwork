import { EventEmitter } from "node:events";
import type { AgentContext, AgentEvent, Stage } from "./types";

const WILDCARD_EVENT = "agent.event";

export class AgentLoopEventEmitter {
  private readonly emitter = new EventEmitter();

  onAny(listener: (event: AgentEvent) => void): () => void {
    this.emitter.on(WILDCARD_EVENT, listener);
    return () => {
      this.emitter.off(WILDCARD_EVENT, listener);
    };
  }

  on<T extends AgentEvent["type"]>(type: T, listener: (event: Extract<AgentEvent, { type: T }>) => void): () => void {
    const wrapped = listener as (event: AgentEvent) => void;
    this.emitter.on(type, wrapped);
    return () => {
      this.emitter.off(type, wrapped);
    };
  }

  emit(event: AgentEvent): void {
    this.emitter.emit(event.type, event);
    this.emitter.emit(WILDCARD_EVENT, event);
  }

  emitStageEnter(ctx: AgentContext, stage: Stage, ts: number): void {
    this.emit({
      type: "agent.stage.enter",
      run_id: ctx.run_id,
      stage,
      fork_depth: ctx.fork_depth,
      ts,
    });
  }

  emitStageExit(ctx: AgentContext, stage: Stage, ok: boolean, duration_ms: number, ts: number): void {
    this.emit({
      type: "agent.stage.exit",
      run_id: ctx.run_id,
      stage,
      ok,
      duration_ms,
      fork_depth: ctx.fork_depth,
      ts,
    });
  }

  emitStageFail(ctx: AgentContext, stage: Stage, error_code: string, ts: number): void {
    this.emit({
      type: "agent.stage.fail",
      run_id: ctx.run_id,
      stage,
      error_code,
      ts,
    });
  }

  emitForkStart(parent: AgentContext, child: AgentContext, ts: number): void {
    this.emit({
      type: "agent.fork.start",
      run_id: child.run_id,
      parent_run_id: parent.run_id,
      fork_depth: child.fork_depth,
      ts,
    });
  }

  emitForkEnd(parent: AgentContext, child: AgentContext, ok: boolean, ts: number): void {
    this.emit({
      type: "agent.fork.end",
      run_id: child.run_id,
      parent_run_id: parent.run_id,
      fork_depth: child.fork_depth,
      ok,
      ts,
    });
  }

  emitRejected(ctx: AgentContext, ts: number): void {
    this.emit({
      type: "rejected",
      run_id: ctx.run_id,
      stage: "verify",
      ts,
    });
  }

  emitCommitFailed(ctx: AgentContext, ts: number): void {
    this.emit({
      type: "commit_failed",
      run_id: ctx.run_id,
      stage: "commit",
      ts,
    });
  }
}

export const defaultAgentEventEmitter = new AgentLoopEventEmitter();
