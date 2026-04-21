import type { FlowState } from "@evodesk/shared";
import type { SlotName } from "./registry.js";

const TELEMETRY_MAX_RECORDS = 10_000;
const DEFAULT_RECENT_LIMIT = 100;
const FLOW_STATES: readonly FlowState[] = ["FLOW", "BOREDOM", "ANXIETY", "APATHY"];

export interface RouterDecisionEvent {
  ts: number;
  flowState: FlowState;
  slot: SlotName;
  selectedProvider: string;
  fallbackPath?: string[];
  attempts?: number;
  durationMs: number;
  outcome: "success" | "fail_closed" | "circuit_open";
}

const telemetryBuffer: RouterDecisionEvent[] = [];
const counters: {
  total: number;
  perFlow: Record<FlowState, { total: number; success: number; failed: number }>;
  fallbackCount: number;
  failClosedCount: number;
} = {
  total: 0,
  perFlow: {
    FLOW: { total: 0, success: 0, failed: 0 },
    BOREDOM: { total: 0, success: 0, failed: 0 },
    ANXIETY: { total: 0, success: 0, failed: 0 },
    APATHY: { total: 0, success: 0, failed: 0 },
  },
  fallbackCount: 0,
  failClosedCount: 0,
};

function incrementCounters(event: RouterDecisionEvent): void {
  counters.total += 1;
  const bucket = counters.perFlow[event.flowState];
  bucket.total += 1;
  if (event.outcome === "success") {
    bucket.success += 1;
  } else {
    bucket.failed += 1;
  }
  if ((event.fallbackPath?.length ?? 0) > 1) counters.fallbackCount += 1;
  if (event.outcome === "fail_closed") counters.failClosedCount += 1;
}

function decrementCounters(event: RouterDecisionEvent): void {
  counters.total -= 1;
  const bucket = counters.perFlow[event.flowState];
  bucket.total -= 1;
  if (event.outcome === "success") {
    bucket.success -= 1;
  } else {
    bucket.failed -= 1;
  }
  if ((event.fallbackPath?.length ?? 0) > 1) counters.fallbackCount -= 1;
  if (event.outcome === "fail_closed") counters.failClosedCount -= 1;
}

export function recordDecision(event: RouterDecisionEvent): void {
  const copy = { ...event, fallbackPath: event.fallbackPath ? [...event.fallbackPath] : undefined };
  telemetryBuffer.push(copy);
  incrementCounters(copy);

  while (telemetryBuffer.length > TELEMETRY_MAX_RECORDS) {
    const evicted = telemetryBuffer.shift();
    if (evicted) decrementCounters(evicted);
  }
}

export function getRecentDecisions(limit = DEFAULT_RECENT_LIMIT): RouterDecisionEvent[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_RECENT_LIMIT;
  if (safeLimit === 0) return [];
  return telemetryBuffer.slice(-safeLimit).map((event) => ({
    ...event,
    fallbackPath: event.fallbackPath ? [...event.fallbackPath] : undefined,
  }));
}

export function getDecisionStats(): {
  perFlow: Record<FlowState, { total: number; success: number; failed: number }>;
  fallbackRate: number;
  failClosedRate: number;
} {
  const perFlow = Object.fromEntries(
    FLOW_STATES.map((state) => [state, { ...counters.perFlow[state] }]),
  ) as Record<FlowState, { total: number; success: number; failed: number }>;
  return {
    perFlow,
    fallbackRate: counters.total > 0 ? counters.fallbackCount / counters.total : 0,
    failClosedRate: counters.total > 0 ? counters.failClosedCount / counters.total : 0,
  };
}

export function clearTelemetry(): void {
  telemetryBuffer.length = 0;
  counters.total = 0;
  counters.fallbackCount = 0;
  counters.failClosedCount = 0;
  for (const state of FLOW_STATES) {
    counters.perFlow[state] = { total: 0, success: 0, failed: 0 };
  }
}
