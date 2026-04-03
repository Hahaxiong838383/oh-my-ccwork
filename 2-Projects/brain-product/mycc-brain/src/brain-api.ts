/**
 * brain-api.ts — OpenAI-compatible 代理层核心
 *
 * POST /v1/chat/completions  → 解析请求 → model 路由 → 调适配器 → SSE
 * GET  /v1/models            → 返回可用模型列表
 */

import type { IncomingMessage, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { resolve } from "path";
import { type BrainConfig, type ModelRoute } from "./config.js";
import { streamOpenAICompat, type OpenAIMessage } from "./adapters/openai-compat.js";
import { loadBrainContext, buildBrainSystemPrompt, type BrainContextResult } from "./services/brain-context.js";
import { loadActivePatches } from "./services/hot-patch.js";
import { writeExperience, type ExperienceEntry } from "./services/experience-stream.js";
import { resolveConversation, saveToConversation } from "./services/conversation.js";

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
    const modelName: string = body.model ?? "cc-qwen";
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

    if (route.brain) {
      try {
        const brainRoot = resolve(import.meta.dirname, "..");
        brainResult = await loadBrainContext(userQuery, this.config.dataDir);
        const patches = loadActivePatches(brainRoot);
        const systemPrompt = buildBrainSystemPrompt(brainResult.context, patches);
        messages = [{ role: "system", content: systemPrompt }, ...messages];
        console.log(`[brain] injected ${brainResult.itemCount} items from [${brainResult.matchedCategories.join(", ")}]`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[brain] memory injection failed: ${msg}`);
      }
    }

    const startMs = Date.now();

    if (!stream) {
      // 非流式
      const { chatCompletion } = await import("./adapters/openai-compat.js");
      const result = await chatCompletion({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
      });

      const latency = Date.now() - startMs;
      console.log(`[brain] ${modelName} non-stream ${latency}ms`);

      // 异步写入经验流（不阻塞响应）
      this.recordExperience(modelName, userQuery, result.content, latency, brainResult);

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
        temperature: body.temperature,
        max_tokens: body.max_tokens,
      },
      res
    );

    const latency = Date.now() - startMs;
    console.log(`[brain] ${modelName} done ${latency}ms`);

    // 异步写入经验流（流式无法获取完整响应，只记录元数据）
    this.recordExperience(modelName, userQuery, "[stream]", latency, brainResult);
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
    };
    writeExperience(brainRoot, entry).catch(() => {});
  }

  getStats() {
    resetDailyStats();
    return { ...stats };
  }

  updateConfig(newConfig: BrainConfig) {
    this.config = newConfig;
  }
}
