import type { FlowState } from "@evodesk/shared";
import {
  type ProviderConfig,
  type ProviderHealth,
  type Registry,
  type SlotName,
} from "./registry.js";

export const K_ROUTER_FLOW_STATES = ["FLOW", "BOREDOM", "ANXIETY", "APATHY"] as const;
export const K_ROUTER_FAIL_CLOSED_CODE = "NO_CANDIDATE" as const;

export type RoutePreference = "quality" | "balanced" | "availability" | "local_first";

export const FLOW_POLICY: Readonly<Record<FlowState, Readonly<Record<SlotName, RoutePreference>>>> = Object.freeze({
  // 心流对齐（0.8-1.2）：全面质量优先；embed 用 balanced 兼顾延迟
  FLOW: Object.freeze({
    chat: "quality",
    extract: "quality",
    embed: "balanced",
    vision: "quality",
    tool_use: "quality",
  }),
  // 技能远超挑战：成本/质量平衡，避免 overkill
  BOREDOM: Object.freeze({
    chat: "balanced",
    extract: "balanced",
    embed: "balanced",
    vision: "balanced",
    tool_use: "balanced",
  }),
  // 挑战远超技能：用户需要强模型协助（gemini 战略建议：chat/tool_use 回归 quality）
  ANXIETY: Object.freeze({
    chat: "quality",
    extract: "quality",
    embed: "availability",
    vision: "quality",
    tool_use: "quality",
  }),
  // 降智检测：本地优先；vision 例外保持 balanced（本地小模型 vision 质量不足，gemini 战略建议）
  APATHY: Object.freeze({
    chat: "local_first",
    extract: "local_first",
    embed: "local_first",
    vision: "balanced",
    tool_use: "local_first",
  }),
});

export type RouteContext = {
  readonly userId?: string;
  readonly excludeIds?: readonly string[];
};

export type RouteSuccess = {
  readonly ok: true;
  readonly provider: ProviderConfig;
  readonly score: number;
  readonly preference: RoutePreference;
  readonly candidatesConsidered: number;
  readonly fallbackApplied: boolean;
};

export type RouteFailure = {
  readonly ok: false;
  readonly code: typeof K_ROUTER_FAIL_CLOSED_CODE;
  readonly reason: string;
};

export type RouteResult = RouteSuccess | RouteFailure;

const MAX_PRIORITY = 10_000;
const MAX_LATENCY_MS = 10_000;

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function priorityInv(p: ProviderConfig): number {
  return clamp01(1 - p.priority / MAX_PRIORITY);
}

function costScalar(p: ProviderConfig): number {
  const sum = p.cost.input_per_1k + p.cost.output_per_1k;
  return clamp01(sum);
}

function latencyScalar(p: ProviderConfig): number {
  return clamp01(p.latency_p95 / MAX_LATENCY_MS);
}

function healthScalar(health: ProviderHealth | undefined): number {
  if (!health) return 0;
  if (health.state === "healthy") return 1;
  if (health.state === "unknown") return 0.5;
  return 0;
}

function isLocal(p: ProviderConfig): number {
  return p.kind === "local" ? 1 : 0;
}

export function scoreCandidate(
  p: ProviderConfig,
  health: ProviderHealth | undefined,
  preference: RoutePreference,
): number {
  const pri = priorityInv(p);
  const cost = costScalar(p);
  const lat = latencyScalar(p);
  const hp = healthScalar(health);
  switch (preference) {
    case "quality":
      return pri * 0.5 + (1 - cost) * 0.2 + hp * 0.3;
    case "balanced":
      return pri * 0.3 + (1 - cost) * 0.3 + hp * 0.2 + (1 - lat) * 0.2;
    case "availability":
      return hp * 0.5 + (1 - lat) * 0.3 + pri * 0.2;
    case "local_first":
      return isLocal(p) * 0.6 + hp * 0.2 + pri * 0.2;
  }
}

function pickPreference(flowState: FlowState, slot: SlotName): RoutePreference {
  const perFlow = FLOW_POLICY[flowState];
  return perFlow[slot];
}

function filterCandidates(
  registry: Registry,
  slot: SlotName,
  ctx: RouteContext | undefined,
): readonly ProviderConfig[] {
  const exclude = new Set(ctx?.excludeIds ?? []);
  return registry.list().filter((p) => {
    if (exclude.has(p.id)) return false;
    if (!p.enabled) return false;
    const cap = p.capabilities[slot];
    return cap?.enabled === true;
  });
}

function healthFor(registry: Registry, id: string): ProviderHealth | undefined {
  const h = registry.health(id);
  if (!h || typeof h !== "object") return undefined;
  return "state" in h ? (h as ProviderHealth) : undefined;
}

export function selectProvider(
  registry: Registry,
  slot: SlotName,
  flowState: FlowState,
  ctx: RouteContext = {},
): RouteResult {
  if (!K_ROUTER_FLOW_STATES.includes(flowState)) {
    return { ok: false, code: K_ROUTER_FAIL_CLOSED_CODE, reason: `invalid_flow_state:${flowState}` };
  }

  const candidates = filterCandidates(registry, slot, ctx);
  if (candidates.length === 0) {
    return { ok: false, code: K_ROUTER_FAIL_CLOSED_CODE, reason: `no_candidate_for_slot:${slot}` };
  }

  let preference = pickPreference(flowState, slot);

  const getHealth = (id: string): ProviderHealth | undefined => healthFor(registry, id);

  let ranked = candidates.map((p) => ({
    provider: p,
    score: scoreCandidate(p, getHealth(p.id), preference),
  }));

  let fallbackApplied = false;

  // local_first 兜底：无 kind=local 候选时降级到 balanced（gemini 战略建议 — Cloud SaaS 场景）
  if (preference === "local_first" && !candidates.some((p) => p.kind === "local")) {
    preference = "balanced";
    fallbackApplied = true;
    ranked = candidates.map((p) => ({
      provider: p,
      score: scoreCandidate(p, getHealth(p.id), preference),
    }));
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
    return a.provider.id.localeCompare(b.provider.id);
  });

  const best = ranked[0];
  return {
    ok: true,
    provider: best.provider,
    score: best.score,
    preference,
    candidatesConsidered: candidates.length,
    fallbackApplied,
  };
}
