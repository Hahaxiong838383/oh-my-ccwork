/**
 * Verifier 中间件主入口
 *
 * 三层架构：
 *   ① cheap signal（0 token，拦 ~60%）
 *   ② SHA256 cache（24h TTL）
 *   ③ LLM verifier（Gemini Flash，per-criterion 并行）
 *
 * 默认 dry-run：accepted 永远 true，wouldHaveBlocked 记录"若启用会拦"。
 * VERIFIER_MODE=enforce 才真正拦截。
 */

import { createHash } from "crypto";
import { checkCheapSignals, type EvidencePayload } from "./cheap-signals.js";
import { getPolicy, pickCriteriaByRisk, type RiskLevel } from "./policy.js";
import { runLlmVerifier } from "./llm-verifier.js";
import { record as recordStat, type Layer } from "./stats.js";

export interface VerifyRequest {
  readonly source: string;
  readonly claim: string;
  readonly evidence: EvidencePayload;
  readonly riskHint?: RiskLevel;
}

export interface VerifyResponse {
  readonly accepted: boolean;
  readonly confidence: number;
  readonly reason: string;
  readonly layer: Layer;
  readonly mode: "dry-run" | "enforce";
  readonly wouldHaveBlocked: boolean;
  readonly tokenCost: number;
  readonly hits: readonly string[];
}

const cache = new Map<string, { value: VerifyResponse; ts: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_HARD_CAP = 5000;

function isDryRun(): boolean {
  return process.env.VERIFIER_MODE !== "enforce";
}

export async function verify(req: VerifyRequest, cwd: string): Promise<VerifyResponse> {
  const t0 = Date.now();
  const policy = getPolicy(req.source);
  const risk = req.riskHint ?? policy.defaultRisk;
  const mode: "dry-run" | "enforce" = isDryRun() ? "dry-run" : "enforce";

  // ① cheap signal 短路
  const cheap = checkCheapSignals(req.evidence, cwd);
  if (cheap.decisive) {
    const accepted = cheap.accepted ?? true;
    const wouldBlock = !accepted;
    const resp: VerifyResponse = {
      accepted: mode === "enforce" ? accepted : true,
      confidence: cheap.confidence ?? 1.0,
      reason: cheap.reason ?? "",
      layer: "cheap",
      mode,
      wouldHaveBlocked: wouldBlock,
      tokenCost: 0,
      hits: cheap.hits,
    };
    recordStat({
      source: req.source, layer: "cheap", accepted: resp.accepted,
      wouldHaveBlocked: wouldBlock, tokenCost: 0, latencyMs: Date.now() - t0,
    });
    if (wouldBlock) {
      console.warn(`[Verifier:${mode}] would-block source=${req.source} reason="${resp.reason}"`);
    }
    return resp;
  }

  // ② cache
  const key = makeCacheKey(req);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    const resp: VerifyResponse = { ...cached.value, layer: "cache" };
    recordStat({
      source: req.source, layer: "cache", accepted: resp.accepted,
      wouldHaveBlocked: resp.wouldHaveBlocked, tokenCost: 0, latencyMs: Date.now() - t0,
    });
    return resp;
  }

  // ③ LLM verifier — 按 risk 裁剪维度，并行评分
  const activeCriteria = pickCriteriaByRisk(policy.criteria, risk);
  const llmResult = await runLlmVerifier(req.source, req.claim, req.evidence, activeCriteria);

  let confidence: number;
  let reason: string;
  let tokenCost: number;
  let wouldBlock: boolean;

  if (llmResult === null) {
    // 无 GEMINI_PROXY_KEY → 保持 V0.1 stub 行为
    confidence = 0.5;
    reason = "LLM verifier 未配置（无 GEMINI_PROXY_KEY），自动放行";
    tokenCost = 0;
    wouldBlock = false;
  } else {
    confidence = llmResult.confidence;
    reason = llmResult.reason;
    tokenCost = llmResult.tokenCost;
    wouldBlock = confidence < policy.blockThreshold;
  }

  const resp: VerifyResponse = {
    accepted: mode === "enforce" ? !wouldBlock : true,
    confidence,
    reason,
    layer: "llm",
    mode,
    wouldHaveBlocked: wouldBlock,
    tokenCost,
    hits: cheap.hits,
  };
  cacheSet(key, resp);
  recordStat({
    source: req.source, layer: "llm", accepted: resp.accepted,
    wouldHaveBlocked: wouldBlock, tokenCost, latencyMs: Date.now() - t0,
  });
  if (wouldBlock) {
    console.warn(`[Verifier:${mode}] LLM would-block source=${req.source} conf=${confidence.toFixed(2)}`);
  }
  return resp;
}

function makeCacheKey(req: VerifyRequest): string {
  const h = createHash("sha256");
  h.update(req.source);
  h.update("|");
  h.update(req.claim);
  h.update("|");
  h.update(sortedJson(req.evidence));
  return h.digest("hex").slice(0, 32);
}

/** 按 key 排序后再序列化，保证 cache key 稳定（不受对象构造顺序影响） */
function sortedJson(obj: unknown): string {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return JSON.stringify(obj);
  }
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (obj as Record<string, unknown>)[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function cacheSet(key: string, value: VerifyResponse): void {
  cache.set(key, { value, ts: Date.now() });
  if (cache.size > CACHE_HARD_CAP) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
}

export function _resetCache(): void {
  cache.clear();
}

export { snapshot as statsSnapshot } from "./stats.js";
