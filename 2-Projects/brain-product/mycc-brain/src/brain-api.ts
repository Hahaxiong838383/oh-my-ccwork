/**
 * brain-api.ts — OpenAI-compatible 代理层核心
 *
 * POST /v1/chat/completions  → 解析请求 → model 路由 → 调适配器 → SSE
 * GET  /v1/models            → 返回可用模型列表
 */

import type { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { type BrainConfig, type ModelRoute } from "./config.js";
import { DEFAULT_BRAIN_MODEL } from "./env.js";
import { streamOpenAICompat, type OpenAIMessage } from "./adapters/openai-compat.js";
import { loadBrainContext, buildBrainSystemPrompt, type BrainContextResult } from "./services/brain-context.js";
import { loadActivePatches } from "./services/hot-patch.js";
import { writeExperience, type ExperienceEntry } from "./services/experience-stream.js";
import { resolveConversation, saveToConversation } from "./services/conversation.js";
import { inferValenceArousal, updateSessionState, getSessionState, cleanupSessionStates } from "./services/user-state.js";
import {
  recordPrediction,
  verifyLastPrediction,
  predictNextNeed,
  computeResonance,
  decideProactiveAction,
  formatProactiveSuggestion,
} from "./services/prediction-engine.js";
import { getVisualState } from "./services/visual-state.js";
import { applyVisualGate } from "./services/visual-gate.js";
import { detectCorrection, recordCorrection, type CorrectionEvent } from "./services/steering-tax.js";
import { loadSoul } from "./services/soul-loader.js";
import { writeAuditLog } from "./services/audit-log.js";
import { recordTrustEvent, getTrustState, getTrustReport } from "./services/trust-state.js";
import { resetCounter, getVetoState } from "./services/veto-spiral.js";
import { evaluate as guardEvaluate } from "./services/constitutional-guard.js";

// ─── 视觉习惯缓存 ───

interface VisualHabits {
  updatedAt: string;
  avgArrival: string;
  avgDeparture: string;
  avgPresentHours: number;
  typicalBreak: string;
  frequentObjects: string[];
  daysAnalyzed: number;
}

let _visualHabitsCache: VisualHabits | null = null;
let _visualHabitsLoadedAt = 0;
const HABITS_CACHE_TTL = 3600_000; // 1 小时

function loadVisualHabits(): VisualHabits | null {
  const now = Date.now();
  if (_visualHabitsCache && (now - _visualHabitsLoadedAt) < HABITS_CACHE_TTL) {
    return _visualHabitsCache;
  }
  try {
    const habitsPath = resolve(import.meta.dirname, "..", "data", "patterns", "visual-habits.json");
    if (!existsSync(habitsPath)) return null;
    const data = JSON.parse(readFileSync(habitsPath, "utf-8"));
    // 检查 updatedAt 在 7 天内
    const updatedAt = new Date(data.updatedAt);
    if (Date.now() - updatedAt.getTime() > 7 * 86400_000) return null;
    _visualHabitsCache = data;
    _visualHabitsLoadedAt = now;
    return data;
  } catch {
    return null;
  }
}

// 简单内存统计
const stats = {
  totalRequests: 0,
  todayRequests: 0,
  todayTokens: 0,
  errors: 0,
  lastReset: new Date().toDateString(),
};

function resetDailyStats() {
  const today = new Date().toDateString();
  if (stats.lastReset !== today) {
    stats.todayRequests = 0;
    stats.todayTokens = 0;
    stats.lastReset = today;
  }
}

function generateId(): string {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function formatEnvironmentHint(visual: ReturnType<typeof getVisualState>): string {
  if (!visual.available || visual.stale) {
    return "";
  }

  const positionLabel = visual.present === true
    ? "在工位"
    : visual.present === false
      ? "离开"
      : "未知";
  const noiseLabel = !visual.audioAvailable
    ? "未知"
    : visual.audioLevel === null || !Number.isFinite(visual.audioLevel)
      ? "未知"
      : visual.audioLevel < 0.03
        ? "安静"
        : visual.audioLevel < 0.12
          ? "有环境声"
          : "较嘈杂";

  const semanticLines: string[] = [];
  if (visual.semanticAvailable && !visual.semanticStale) {
    if (visual.sceneSummary && visual.sceneSummary !== "unknown") {
      semanticLines.push(`- 场景摘要: ${visual.sceneSummary}`);
    }
    if (visual.personAppearance && visual.personAppearance !== "unknown") {
      semanticLines.push(`- 人物外观: ${visual.personAppearance}`);
    }
    if (visual.personAction && visual.personAction !== "unknown" && visual.personAction !== visual.activity) {
      semanticLines.push(`- 人物动作: ${visual.personAction}`);
    }
    if (visual.nearbyObjects.length > 0) {
      semanticLines.push(`- 附近物体: ${visual.nearbyObjects.join("、")}`);
    }
    if (visual.rawText && visual.rawText !== "unknown" && visual.rawText !== "当前工位无人" && visual.rawText !== "模型不可用") {
      semanticLines.push(`- 摄像头实时画面: ${visual.rawText}`);
    }
  }

  // 最近变化事件
  if (visual.lastChange) {
    const changeLabels: Record<string, string> = {
      person_arrived: "有人来了",
      person_left: "人走了",
      scene_changed: "场景变化",
    };
    const label = changeLabels[visual.lastChange.event] ?? visual.lastChange.event;
    semanticLines.push(`- 最近变化: [${label}] ${visual.lastChange.detail}`);
  }

  // 最近视觉观察历史（去重，最多 3 条与当前不同的）
  if (visual.recentObservations.length > 1) {
    const currentRaw = visual.rawText ?? "";
    const historyEntries: string[] = [];
    for (let i = visual.recentObservations.length - 2; i >= 0 && historyEntries.length < 3; i--) {
      const obs = visual.recentObservations[i];
      if (obs.rawText && obs.rawText !== currentRaw) {
        const timeStr = obs.ts ? new Date(obs.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "??:??";
        const presenceLabel = obs.present === true ? "在工位" : obs.present === false ? "离开" : "未知";
        const changeTag = obs.change ? `（${obs.change}）` : "";
        historyEntries.push(`- ${timeStr} [${presenceLabel}] ${obs.rawText.slice(0, 60)}...${changeTag}`);
      }
    }
    if (historyEntries.length > 0) {
      semanticLines.push(`\n### 最近视觉观察\n${historyEntries.join("\n")}`);
    }
  }

  // 注入视觉习惯数据（来自每日聚合）
  const habits = loadVisualHabits();
  if (habits) {
    semanticLines.push(`\n### 用户习惯（视觉学习）`);
    semanticLines.push(`- 通常到达: ${habits.avgArrival} | 通常离开: ${habits.avgDeparture} | 日均在位: ${habits.avgPresentHours}h`);
    semanticLines.push(`- 午休时段: ${habits.typicalBreak}`);
    if (habits.frequentObjects?.length > 0) {
      semanticLines.push(`- 工位常见物品: ${habits.frequentObjects.join("、")}`);
    }
  }

  return `\n\n## 用户环境感知\n- 位置状态: ${positionLabel}\n- 活动状态: ${visual.activity}\n- 环境音量: ${noiseLabel}${semanticLines.length > 0 ? `\n${semanticLines.join("\n")}` : ""}`;
}

export class BrainApi {
  constructor(private config: BrainConfig) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (path === "/v1/chat/completions" && req.method === "POST") {
        await this.handleChatCompletions(req, res);
      } else if (path === "/v1/models" && req.method === "GET") {
        this.handleModels(res);
      } else {
        json(res, 404, { error: { message: "Not found", type: "invalid_request" } });
      }
    } catch (e: any) {
      stats.errors++;
      console.error("[brain-api] error:", e.message);
      json(res, 500, { error: { message: e.message, type: "internal_error" } });
    }
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
    resetDailyStats();
    stats.totalRequests++;
    stats.todayRequests++;

    const body = JSON.parse(await readBody(req));
    const modelName: string = body.model ?? this.config.defaultBrainModel ?? DEFAULT_BRAIN_MODEL;
    const stream: boolean = body.stream ?? true;

    // P2: Multi-turn conversation
    const { conversationId, messages: resolvedMessages } = resolveConversation(
      body.conversation_id,
      body.messages ?? [],
    );
    let messages: OpenAIMessage[] = resolvedMessages;

    const route = this.config.routes[modelName];
    if (!route) {
      json(res, 400, {
        error: {
          message: `Unknown model: ${modelName}. Available: ${Object.keys(this.config.routes).join(", ")}`,
          type: "invalid_request",
        },
      });
      return;
    }

    if (!route.apiKey || route.apiKey === "") {
      json(res, 503, {
        error: {
          message: `API key not configured for ${modelName}`,
          type: "configuration_error",
        },
      });
      return;
    }

    // D2: 记忆注入 — brain=true 时注入 system prompt
    let brainResult: BrainContextResult | null = null;
    const userQuery = messages[messages.length - 1]?.content ?? "";

    // GAP4+5: 情感标注 + 用户状态推断（零延迟规则驱动）
    const va = inferValenceArousal(userQuery);
    const visual = route.brain ? getVisualState() : null;
    const userState = updateSessionState(conversationId, userQuery, visual ?? undefined);
    const sessionState = getSessionState(conversationId);

    // Phase 1 P0: steering_tax — 检测用户纠正模式
    if (route.brain) {
      const rawCorrection = detectCorrection(userQuery);
      if (rawCorrection) {
        const brainRootForTax = resolve(import.meta.dirname, "..");
        // detectCorrection 返回 readonly，用扩展创建含 conversationId 的新对象
        const correctionWithId: CorrectionEvent = {
          ...rawCorrection,
          conversationId,
        };
        recordCorrection(brainRootForTax, correctionWithId);
        writeAuditLog(brainRootForTax, {
          ts: new Date().toISOString(),
          type: "steering",
          action: rawCorrection.correctionType,
          detail: `correction detected (${rawCorrection.confidence.toFixed(2)}): ${userQuery.slice(0, 80)}`,
        });
        console.log(`[brain] steering_tax: ${rawCorrection.correctionType} (conf=${rawCorrection.confidence.toFixed(2)})`);
      }
    }

    if (route.brain) {
      try {
        const brainRoot = resolve(import.meta.dirname, "..");
        brainResult = await loadBrainContext(userQuery, this.config.dataDir);
        const patches = loadActivePatches(brainRoot);
        // 检索为空时注入防编造标记
        let context = brainResult.context;
        if (brainResult.itemCount === 0) {
          context += "\n\n[无相关记忆] 以下回答基于模型通用知识，可能不准确。请明确告知用户这一点。";
        }
        const systemPrompt = buildBrainSystemPrompt(context, patches);

        // Phase 1 P0: SOUL.md 身份内核注入（每轮 fresh load，防人格漂移）
        const soulHint = loadSoul(brainRoot) ?? "";

        // GAP5: 注入会话级用户状态（仅当有有效推断时）
        const contextStateHint = (userState.attention !== "unknown" || userState.noiseLevel !== "unknown")
          ? `\n- 注意力状态: ${userState.attention} | 环境音量: ${userState.noiseLevel}`
          : "";
        const stateHint = sessionState
          ? `\n\n## 用户状态（本轮推断）\n- 意图: ${userState.intent} | 情绪: ${userState.mood} | 专业度: ${userState.expertise}${contextStateHint}\n- 会话主导意图: ${sessionState.dominantIntent} | 轮次: ${sessionState.turnCount}\n- 请根据用户状态调整回复风格：受挫时简洁直接，好奇时展开说明，紧急时跳过寒暄。`
          : "";
        const environmentHint = visual ? formatEnvironmentHint(visual) : "";

        const soulSection = soulHint ? `\n\n${soulHint}` : "";
        messages = [{ role: "system", content: systemPrompt + soulSection + stateHint + environmentHint }, ...messages];
        console.log(`[brain] injected ${brainResult.itemCount} items from [${brainResult.matchedCategories.join(", ")}] | state: ${userState.intent}/${userState.mood} | soul: ${soulHint ? "✓" : "—"}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[brain] memory injection failed: ${msg}`);
      }
    }

    // GAP3: 异步验证上一次预测（fire-and-forget）
    const brainRoot = resolve(import.meta.dirname, "..");
    const actualCategory = brainResult?.matchedCategories[0] ?? "unknown";
    verifyLastPrediction(brainRoot, conversationId, userState.intent, actualCategory)
      .then((v) => {
        if (v) console.log(`[brain] prediction verified: ${v.hit ? "✅ hit" : "❌ miss"} (${v.id})`);
      })
      .catch(() => {});

    // GAP3: 主动行为决策 — 基于预测置信度 + 共振度决定是否注入建议
    if (route.brain && messages.length > 0 && messages[0].role === "system") {
      const prediction = predictNextNeed(
        userState.intent,
        actualCategory,
        brainResult?.matchedCategories ?? [],
      );
      // recentValences: 当前会话无充足历史时用空数组（共振度=0 → 保守决策，正确行为）
      const resonance = computeResonance(brainRoot, 14, []);
      const proactive = decideProactiveAction(prediction.confidence, resonance.resonanceScore);

      // Phase 2B-1: 视觉门控（fail-open）
      let gatedLevel = proactive.level;
      try {
        const gated = applyVisualGate(proactive.level, visual ?? getVisualState());
        gatedLevel = gated.level;
        if (gated.applied) {
          console.log(`[brain] visual gate: ${proactive.level} → ${gated.level} (${gated.reason})`);
        }
      } catch { /* fail-open: 视觉异常不影响主链路 */ }

      if (gatedLevel === "suggest" || gatedLevel === "act") {
        const suggestion = formatProactiveSuggestion(
          prediction.predictedIntent,
          prediction.predictedCategory,
          gatedLevel,
        );
        messages = [
          { ...messages[0], content: messages[0].content + suggestion },
          ...messages.slice(1),
        ];
        console.log(`[brain] proactive: ${gatedLevel} (conf=${proactive.adjustedConfidence.toFixed(2)}, ${proactive.reason})`);
      }
    }

    const startMs = Date.now();

    // thinking 开关：仅对 supportsThinking=true 的路由生效，否则不传（避免不支持的 API 报错）
    const enableThinking = route.supportsThinking
      ? (body.enable_thinking ?? false)
      : undefined;

    if (!stream) {
      // 非流式
      const { chatCompletion } = await import("./adapters/openai-compat.js");
      const result = await chatCompletion({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        temperature: body.temperature ?? (route.brain ? 0.3 : undefined),
        max_tokens: body.max_tokens,
        enable_thinking: enableThinking,
      });

      const latency = Date.now() - startMs;
      console.log(`[brain] ${modelName} non-stream ${latency}ms`);

      // 异步写入经验流（不阻塞响应）+ GAP4 情感标注
      this.recordExperience(modelName, userQuery, result.content, latency, brainResult, va.valence, va.arousal);

      // Save to conversation history
      const lastUserMsg = messages.filter((m) => m.role === "user").pop();
      if (lastUserMsg) saveToConversation(conversationId, lastUserMsg, result.content);

      json(res, 200, {
        id: generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        conversation_id: conversationId,
        choices: [{
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        }],
        usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      // Phase 2: 信任状态后处理（fire-and-forget）
      try {
        recordTrustEvent(brainRoot, {
          timestamp: new Date().toISOString(),
          eventType: "approve",
          category: "routine_ok",
          weight: 1,
          source: "brain-api",
        });
        resetCounter(brainRoot);
      } catch { /* fire-and-forget */ }

      return;
    }

    // 流式
    console.log(`[brain] ${modelName} stream → ${route.baseURL}`);

    await streamOpenAICompat(
      {
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        temperature: body.temperature ?? (route.brain ? 0.3 : undefined),
        max_tokens: body.max_tokens,
        enable_thinking: enableThinking,
      },
      res
    );

    const latency = Date.now() - startMs;
    console.log(`[brain] ${modelName} done ${latency}ms`);

    // 异步写入经验流（流式无法获取完整响应，只记录元数据）+ GAP4 情感标注
    this.recordExperience(modelName, userQuery, "[stream]", latency, brainResult, va.valence, va.arousal);

    // Phase 2: 信任状态后处理（fire-and-forget）
    try {
      recordTrustEvent(brainRoot, {
        timestamp: new Date().toISOString(),
        eventType: "approve",
        category: "routine_ok",
        weight: 1,
        source: "brain-api",
      });
      resetCounter(brainRoot);
    } catch { /* fire-and-forget */ }
  }

  private handleModels(res: ServerResponse) {
    const models = Object.keys(this.config.routes).map((id) => ({
      id,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: "mycc-brain",
    }));
    json(res, 200, { object: "list", data: models });
  }

  private recordExperience(
    model: string,
    query: string,
    response: string,
    latencyMs: number,
    brainResult: BrainContextResult | null,
    valence?: number,
    arousal?: number,
  ): void {
    const brainRoot = resolve(import.meta.dirname, "..");
    const entry: ExperienceEntry = {
      timestamp: new Date().toISOString(),
      model,
      query: query.slice(0, 200),
      responseSnippet: response.slice(0, 200),
      latencyMs,
      injectedCategories: brainResult?.matchedCategories ?? [],
      injectedItemCount: brainResult?.itemCount ?? 0,
      retrievalPaths: brainResult?.retrievalPaths ?? [],
      valence,
      arousal,
    };
    writeExperience(brainRoot, entry).catch(() => {});

    // GAP3: 异步记录预测（fire-and-forget）
    const primaryCategory = brainResult?.matchedCategories[0] ?? "unknown";
    const recentCats = brainResult?.matchedCategories ?? [];
    recordPrediction(
      brainRoot,
      "default", // conversationId 在此层不可用，用 default
      entry.model, // 复用 model 作为 intent 近似（后续由 user-state 驱动）
      primaryCategory,
      recentCats,
    ).catch(() => {});

    // 定期清理过期会话状态（每 100 次请求）
    if (stats.totalRequests % 100 === 0) {
      cleanupSessionStates();
    }
  }

  getStats() {
    resetDailyStats();
    return { ...stats };
  }

  updateConfig(newConfig: BrainConfig) {
    this.config = newConfig;
  }
}
