/**
 * mycc-brain 服务入口
 * :19080 — brain API + admin UI
 */

import http from "http";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { BrainApi } from "./brain-api.js";
import { loadBrainContext } from "./services/brain-context.js";
import { listPatches, addPatch, togglePatch, deletePatch } from "./services/hot-patch.js";
import { getTodayStats, getRecentDayStats, getInsights, getHealthMetrics, getMemoryHealth } from "./services/experience-stream.js";
import { getConversationStats } from "./services/conversation.js";
import { diagnoseLatestEval } from "./services/evolution-diagnosis.js";
import { runEvolutionCycle } from "./services/evolution-engine.js";
import { ToolRegistry } from "./services/tool-registry.js";
import { runAgentLoop } from "./services/agent-loop.js";
import { searchMemoryTool } from "./tools/search-memory.js";
import { listMemoriesTool } from "./tools/list-memories.js";
import { runDiagnosisTool } from "./tools/run-diagnosis.js";
import { addMemoryTool } from "./tools/add-memory.js";

import { runMemoryIntake } from "./services/memory-intake.js";
import { parseMemoryItems } from "./services/memory-store.js";
import { McpClient } from "./services/mcp-client.js";
import { bridgeMcpTools, type BridgeResult } from "./services/mcp-bridge.js";
import { getEnabledMcpServers, type McpServerConfig } from "./mcp-config.js";

const config = loadConfig();
const brainApi = new BrainApi(config);

// ─── MCP 连接池 ───

/** 已连接的 MCP Client 缓存（serverName → client） */
const mcpClients = new Map<string, McpClient>();

/** 各 MCP Server 的配置缓存 */
const mcpConfigs = new Map<string, McpServerConfig>();

/** 各 MCP Server 的桥接结果缓存 */
const mcpBridgeResults = new Map<string, BridgeResult>();

/**
 * 连接单个 MCP Server（带错误容忍）
 */
async function connectMcpServer(name: string, cfg: McpServerConfig): Promise<void> {
  try {
    const client = new McpClient(name);
    await client.connect(cfg.command, cfg.args, cfg.env);
    mcpClients.set(name, client);
    mcpConfigs.set(name, cfg);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mcp] ${name} connect failed: ${msg}`);
  }
}

/**
 * 启动时连接所有已启用的 MCP Server
 */
async function initMcpConnections(): Promise<void> {
  const servers = getEnabledMcpServers();
  const names = Object.keys(servers);
  if (names.length === 0) return;

  console.log(`[mcp] connecting ${names.length} servers: ${names.join(", ")}`);
  await Promise.all(
    Object.entries(servers).map(([name, cfg]) => connectMcpServer(name, cfg)),
  );
  console.log(`[mcp] done, ${mcpClients.size}/${names.length} connected`);
}

/**
 * 将所有已连接的 MCP 工具桥接到 ToolRegistry
 */
async function bridgeAllMcpTools(registry: ToolRegistry): Promise<void> {
  for (const [name, client] of mcpClients) {
    if (!client.isConnected()) continue;
    try {
      const result = await bridgeMcpTools(client, registry);
      mcpBridgeResults.set(name, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[mcp] ${name} bridge failed: ${msg}`);
    }
  }
}

const ADMIN_HTML_PATH = resolve(import.meta.dirname, "admin/admin-ui.html");

// P3: Admin auth — check Authorization: Bearer <BRAIN_API_KEY>
function checkAdminAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const key = config.brainApiKey;
  if (!key || key === "sk-brain-dev") return true; // no auth if default key
  const auth = req.headers.authorization;
  if (auth === `Bearer ${key}`) return true;
  json(res, 401, { error: "Unauthorized" });
  return false;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // brain API 路由
  if (path.startsWith("/v1/")) {
    return brainApi.handle(req, res);
  }

  // Admin UI
  if (path === "/admin" || path === "/admin/") {
    if (existsSync(ADMIN_HTML_PATH)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(ADMIN_HTML_PATH, "utf-8"));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>mycc-brain admin</h1><p>admin-ui.html not found</p>");
    }
    return;
  }

  // Static vendor files (local 3D libs etc.)
  if (path.startsWith("/static/")) {
    const safePath = path.replace(/\.\./g, "");
    const filePath = resolve(import.meta.dirname, safePath.slice(1));
    if (existsSync(filePath)) {
      const ext = filePath.endsWith(".js") ? "application/javascript" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": ext, "Cache-Control": "public, max-age=31536000" });
      res.end(readFileSync(filePath));
    } else {
      json(res, 404, { error: "Not found" });
    }
    return;
  }

  // Admin API — auth check for all /admin/api/* routes
  if (path.startsWith("/admin/api/") && !checkAdminAuth(req, res)) return;

  if (path === "/admin/api/status" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const expStats = getTodayStats(brainRoot);
    const expHistory = getRecentDayStats(brainRoot, 7);
    const patches = listPatches(brainRoot);
    json(res, 200, {
      version: "0.2.0",
      uptime: process.uptime(),
      stats: brainApi.getStats(),
      routes: Object.fromEntries(
        Object.entries(config.routes).map(([k, v]) => [
          k,
          { adapter: v.adapter, brain: v.brain, baseURL: v.baseURL, model: v.model, hasKey: !!v.apiKey && v.apiKey !== "" },
        ])
      ),
      dataDir: config.dataDir,
      dataDirExists: existsSync(config.dataDir),
      memoryItemsExists: existsSync(resolve(config.dataDir, "memory-items.md")),
      experience: { today: expStats, history: expHistory },
      patches: { total: patches.length, active: patches.filter((p) => p.active).length },
      conversations: getConversationStats(),
    });
    return;
  }

  if (path === "/admin/api/restart" && req.method === "POST") {
    json(res, 200, { message: "restarting in 1s..." });
    setTimeout(() => process.exit(0), 1000); // pm2 会自动重启
    return;
  }

  if (path === "/admin/api/test" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { chatCompletion } = await import("./adapters/openai-compat.js");
      const modelName = body.model ?? "cc-qwen";
      const route = config.routes[modelName];
      if (!route) {
        json(res, 400, { error: "Unknown model" });
        return;
      }
      const prompt = body.prompt ?? "你好";
      const historyMsgs: Array<{ role: string; content: string }> = body.messages ?? [];
      let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

      // Build conversation: history + current prompt
      if (historyMsgs.length > 0) {
        messages = historyMsgs.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
      }
      messages.push({ role: "user", content: prompt });

      // Inject brain context if route.brain=true (same as /v1/chat/completions)
      if (route.brain) {
        try {
          const brainRoot = resolve(import.meta.dirname, "..");
          const brainResult = await loadBrainContext(prompt, config.dataDir);
          const { loadActivePatches } = await import("./services/hot-patch.js");
          const { buildBrainSystemPrompt } = await import("./services/brain-context.js");
          const patches = loadActivePatches(brainRoot);
          const systemPrompt = buildBrainSystemPrompt(brainResult.context, patches);
          messages = [{ role: "system", content: systemPrompt }, ...messages];
        } catch { /* degrade gracefully */ }
      }

      const enableThinking = route.supportsThinking
        ? (body.enable_thinking ?? false)
        : undefined;
      const result = await chatCompletion({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        max_tokens: route.maxTokens ?? 4096,
        enable_thinking: enableThinking,
      });
      json(res, 200, { content: result.content, usage: result.usage, brain: route.brain });

      // 异步记忆提取（不阻塞响应）
      runMemoryIntake(
        { userMessage: prompt, assistantReply: result.content, history: historyMsgs, dataDir: config.dataDir },
        config.memoryLLM.intake,
        config.memoryLLM.fallbackIntake,
      ).catch(err => console.error("[memory-intake]", err instanceof Error ? err.message : err));
    } catch (e: any) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // Admin API: A/B compare — raw vs brain side-by-side
  if (path === "/admin/api/compare" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { chatCompletion } = await import("./adapters/openai-compat.js");
      const modelParam: string = body.model ?? "cc-qwen";
      const prompt: string = body.prompt ?? "你好";

      // Extract suffix: cc-qwen → qwen, raw-deepseek → deepseek
      const suffix = modelParam.replace(/^(cc|raw)-/, "");
      const brainModelName = `cc-${suffix}`;
      const rawModelName = `raw-${suffix}`;

      const brainRoute = config.routes[brainModelName];
      const rawRoute = config.routes[rawModelName];
      if (!brainRoute || !rawRoute) {
        json(res, 400, { error: `Model pair not found: ${brainModelName} / ${rawModelName}` });
        return;
      }

      // Prepare brain messages (with memory injection)
      let brainMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "user", content: prompt }];
      let injectedCategories: string[] = [];
      let itemCount = 0;
      try {
        const brainRoot = resolve(import.meta.dirname, "..");
        const brainResult = await loadBrainContext(prompt, config.dataDir);
        const { loadActivePatches } = await import("./services/hot-patch.js");
        const { buildBrainSystemPrompt } = await import("./services/brain-context.js");
        const patches = loadActivePatches(brainRoot);
        const systemPrompt = buildBrainSystemPrompt(brainResult.context, patches);
        brainMessages = [{ role: "system", content: systemPrompt }, ...brainMessages];
        injectedCategories = brainResult.matchedCategories;
        itemCount = brainResult.itemCount;
      } catch { /* degrade gracefully */ }

      const rawMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "user", content: prompt }];

      const rawThinking = rawRoute.supportsThinking ? (body.enable_thinking ?? false) : undefined;
      const brainThinking = brainRoute.supportsThinking ? (body.enable_thinking ?? false) : undefined;

      // Parallel calls
      const rawStart = Date.now();
      const brainStart = Date.now();

      const [rawResult, brainResultResp] = await Promise.all([
        chatCompletion({
          baseURL: rawRoute.baseURL,
          apiKey: rawRoute.apiKey,
          model: rawRoute.model,
          messages: rawMessages,
          max_tokens: 8192,
          enable_thinking: rawThinking,
        }).then((r) => ({ ...r, latency: Date.now() - rawStart })),
        chatCompletion({
          baseURL: brainRoute.baseURL,
          apiKey: brainRoute.apiKey,
          model: brainRoute.model,
          messages: brainMessages,
          max_tokens: 8192,
          enable_thinking: brainThinking,
        }).then((r) => ({ ...r, latency: Date.now() - brainStart })),
      ]);

      json(res, 200, {
        raw: { content: rawResult.content, usage: rawResult.usage },
        brain: { content: brainResultResp.content, usage: brainResultResp.usage, injectedCategories, itemCount },
        latency: { raw: rawResult.latency, brain: brainResultResp.latency },
      });

      // 用 brain 回复做记忆提取（不阻塞响应）
      runMemoryIntake(
        { userMessage: prompt, assistantReply: brainResultResp.content, dataDir: config.dataDir },
        config.memoryLLM.intake,
        config.memoryLLM.fallbackIntake,
      ).catch(err => console.error("[memory-intake]", err instanceof Error ? err.message : err));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: hot-patch management
  if (path === "/admin/api/patches" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    json(res, 200, listPatches(brainRoot));
    return;
  }

  if (path === "/admin/api/patches" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const brainRoot = resolve(import.meta.dirname, "..");
      if (body.action === "add" && body.rule) {
        const patch = addPatch(brainRoot, body.rule);
        json(res, 200, patch);
      } else if (body.action === "toggle" && body.id !== undefined) {
        const ok = togglePatch(brainRoot, body.id, body.active ?? false);
        json(res, 200, { ok });
      } else if (body.action === "delete" && body.id) {
        const ok = deletePatch(brainRoot, body.id);
        json(res, 200, { ok });
      } else {
        json(res, 400, { error: "Invalid action" });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: memory preview (test injection for a query)
  if (path === "/admin/api/memory-preview" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const result = await loadBrainContext(body.query ?? "你好", config.dataDir);
      json(res, 200, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: memory items — 返回 memory-items.md 结构化数据 + 健康指标
  if (path === "/admin/api/memory/items" && req.method === "GET") {
    try {
      const parsed = parseMemoryItems(config.dataDir);
      const today = new Date();
      const categories = parsed.map((cat) => {
        const items = cat.items.map((raw) => {
          const starMatch = raw.match(/^-\s*(★+)/);
          const star = starMatch ? starMatch[1].length : 0;
          const dateMatch = raw.match(/\[(\d{4}-\d{2}-\d{2})\]/);
          const date = dateMatch ? dateMatch[1] : null;
          const tagMatches = raw.match(/#(\S+)/g);
          const tags = tagMatches ? tagMatches.map((t) => t.slice(1)) : [];
          const hasConflict = raw.includes("[conflict]") || raw.includes("[矛盾]");
          return { raw, star, date, tags, hasConflict };
        });
        return {
          name: cat.header.match(/\[(.+?)\]/)?.[1] ?? cat.header,
          items,
          itemCount: items.length,
        };
      });

      const totalItems = categories.reduce((s, c) => s + c.itemCount, 0);
      let conflictCount = 0;
      let expiredCount = 0;
      let totalAge = 0;
      let datedCount = 0;
      let lastWriteDate: string | null = null;

      for (const cat of categories) {
        for (const item of cat.items) {
          if (item.hasConflict) conflictCount++;
          if (item.date) {
            datedCount++;
            const itemDate = new Date(item.date);
            const ageDays = (today.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24);
            totalAge += ageDays;
            if (ageDays > 180) expiredCount++;
            if (!lastWriteDate || item.date > lastWriteDate) lastWriteDate = item.date;
          }
        }
      }

      json(res, 200, {
        categories,
        totalItems,
        health: {
          conflictCount,
          expiredCount,
          avgAge: datedCount > 0 ? Math.round((totalAge / datedCount) * 10) / 10 : 0,
          lastWriteDate,
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: model config — GET 返回当前模型配置，POST 保存覆盖
  if (path === "/admin/api/config/models" && req.method === "GET") {
    const maskKey = (key: string): string => {
      if (!key || key.length <= 8) return key ? "***" : "";
      return key.slice(0, 8) + "...";
    };
    const routes = Object.fromEntries(
      Object.entries(config.routes).map(([k, v]) => [
        k,
        { adapter: v.adapter, brain: v.brain, baseURL: v.baseURL, model: v.model, hasKey: !!v.apiKey && v.apiKey !== "" },
      ])
    );
    const memoryLLM = {
      intake: { baseURL: config.memoryLLM.intake.baseURL, model: config.memoryLLM.intake.model, apiKey: maskKey(config.memoryLLM.intake.apiKey) },
      consolidation: { baseURL: config.memoryLLM.consolidation.baseURL, model: config.memoryLLM.consolidation.model, apiKey: maskKey(config.memoryLLM.consolidation.apiKey) },
      fallbackIntake: config.memoryLLM.fallbackIntake
        ? { baseURL: config.memoryLLM.fallbackIntake.baseURL, model: config.memoryLLM.fallbackIntake.model, apiKey: maskKey(config.memoryLLM.fallbackIntake.apiKey) }
        : null,
    };
    json(res, 200, { routes, memoryLLM });
    return;
  }

  if (path === "/admin/api/config/models" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const brainRoot = resolve(import.meta.dirname, "..");
      const dataDir = resolve(brainRoot, "data");
      mkdirSync(dataDir, { recursive: true });
      const overridesPath = resolve(dataDir, "model-config-overrides.json");
      const overrides: Record<string, unknown> = {};
      if (body.memoryLLM) {
        const mem: Record<string, unknown> = {};
        if (body.memoryLLM.intake) {
          mem.intake = {
            baseURL: String(body.memoryLLM.intake.baseURL ?? ""),
            model: String(body.memoryLLM.intake.model ?? ""),
            apiKey: String(body.memoryLLM.intake.apiKey ?? ""),
          };
        }
        if (body.memoryLLM.consolidation) {
          mem.consolidation = {
            baseURL: String(body.memoryLLM.consolidation.baseURL ?? ""),
            model: String(body.memoryLLM.consolidation.model ?? ""),
            apiKey: String(body.memoryLLM.consolidation.apiKey ?? ""),
          };
        }
        if (body.memoryLLM.fallbackIntake !== undefined) {
          mem.fallbackIntake = body.memoryLLM.fallbackIntake;
        }
        overrides.memoryLLM = mem;
      }
      writeFileSync(overridesPath, JSON.stringify(overrides, null, 2), "utf-8");
      json(res, 200, { ok: true, message: "已保存，需要重启服务生效" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: experience export
  if (path === "/admin/api/experiences/export" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const d = new Date().toISOString().slice(0, 10);
    const fp = resolve(brainRoot, `data/experiences/${d}.jsonl`);
    if (existsSync(fp)) {
      const content = readFileSync(fp, "utf-8");
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="experiences-${d}.jsonl"`,
      });
      res.end(content);
    } else {
      json(res, 404, { error: "No experience data for today" });
    }
    return;
  }

  // Admin API: experience insights report
  if (path === "/admin/api/insights" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const days = parseInt(url.searchParams.get("days") ?? "7", 10);
    const clampedDays = Math.max(1, Math.min(days, 90));
    json(res, 200, getInsights(brainRoot, clampedDays));
    return;
  }

  // Admin API: health metrics (retrieval path hits, latency percentiles, miss rate)
  if (path === "/admin/api/health-metrics" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const days = parseInt(url.searchParams.get("days") ?? "7", 10);
    const clampedDays = Math.max(1, Math.min(days, 90));
    json(res, 200, getHealthMetrics(brainRoot, clampedDays));
    return;
  }

  // Admin API: memory health (supply-side insights)
  if (path === "/admin/api/memory-health" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    const clampedDays = Math.max(1, Math.min(days, 90));
    json(res, 200, getMemoryHealth(brainRoot, clampedDays));
    return;
  }

  // Admin API: evolution — latest diagnosis
  if (path === "/admin/api/evolution/diagnosis" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const report = diagnoseLatestEval(brainRoot);
    json(res, 200, report ?? { error: "no eval data yet" });
    return;
  }

  // Admin API: evolution — action log (read evolution-log.jsonl, last N entries)
  if (path === "/admin/api/evolution/log" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const logPath = resolve(brainRoot, "data/evolution-log.jsonl");
    const entries: unknown[] = [];
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
      const start = Math.max(0, lines.length - limit);
      for (let i = start; i < lines.length; i++) {
        try { entries.push(JSON.parse(lines[i])); } catch { /* skip malformed */ }
      }
    }
    json(res, 200, { total: entries.length, entries });
    return;
  }

  // Admin API: evolution — latest eval result
  if (path === "/admin/api/evolution/eval-result" && req.method === "GET") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const resultPath = resolve(brainRoot, "eval/eval-result.json");
    if (existsSync(resultPath)) {
      try {
        json(res, 200, JSON.parse(readFileSync(resultPath, "utf-8")));
      } catch { json(res, 500, { error: "parse failed" }); }
    } else {
      json(res, 200, { error: "no eval result yet" });
    }
    return;
  }

  // Admin API: evolution — trigger one cycle
  if (path === "/admin/api/evolution/run" && req.method === "POST") {
    const brainRoot = resolve(import.meta.dirname, "..");
    const result = runEvolutionCycle(brainRoot);
    json(res, 200, result ?? { error: "no diagnosis available" });
    return;
  }

  // Admin API: agent/stream — SSE 流式 Agent Loop，实时推送中间步骤
  if (path === "/admin/api/agent/stream" && req.method === "POST") {
    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // nginx 不缓冲
    });

    const sendSSE = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const body = JSON.parse(await readBody(req));
      const modelParam: string = body.model ?? "cc-qwen";
      const prompt: string = body.prompt ?? "";
      if (!prompt) { sendSSE("error", { error: "prompt required" }); res.end(); return; }

      const route = config.routes[modelParam];
      if (!route) { sendSSE("error", { error: `Model not found: ${modelParam}` }); res.end(); return; }

      // Build tool registry（内置工具 + MCP 桥接工具）
      const registry = new ToolRegistry();
      registry.register(searchMemoryTool);
      registry.register(listMemoriesTool);
      registry.register(runDiagnosisTool);
      registry.register(addMemoryTool);
      await bridgeAllMcpTools(registry);

      const brainRoot = resolve(import.meta.dirname, "..");
      const toolMap = new Map(registry.list().map(t => [t.name, t]));

      // Build initial messages with memory injection + conversation history
      const historyMsgs: Array<{ role: string; content: string }> = body.messages ?? [];
      const messages: Array<{ role: string; content: string }> = [];
      try {
        const brainResult = await loadBrainContext(prompt, config.dataDir);
        const { loadActivePatches } = await import("./services/hot-patch.js");
        const { buildBrainSystemPrompt } = await import("./services/brain-context.js");
        const patches = loadActivePatches(brainRoot);
        const systemPrompt = buildBrainSystemPrompt(brainResult.context, patches);
        messages.push({ role: "system", content: systemPrompt });
      } catch { /* degrade gracefully */ }
      for (const m of historyMsgs) {
        if (m.role && m.content) messages.push({ role: m.role, content: m.content });
      }
      messages.push({ role: "user", content: prompt });

      const enableThinking = route.supportsThinking ? (body.enable_thinking ?? false) : undefined;
      const result = await runAgentLoop({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        tools: toolMap,
        toolContext: { brainRoot, dataDir: config.dataDir },
        maxSteps: 10,
        maxTokens: route.maxTokens,
        temperature: 0.7,
        enableThinking,
        onStep: (step) => sendSSE("step", step),
      });

      sendSSE("done", {
        content: result.content,
        totalTokens: result.totalTokens,
        toolsUsed: result.toolsUsed,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendSSE("error", { error: msg });
    }

    res.end();
    return;
  }

  // Admin API: agent — run agent loop with tools（同步，保留兼容）
  if (path === "/admin/api/agent" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const modelParam: string = body.model ?? "cc-qwen";
      const prompt: string = body.prompt ?? "";
      if (!prompt) { json(res, 400, { error: "prompt required" }); return; }

      const route = config.routes[modelParam];
      if (!route) { json(res, 400, { error: `Model not found: ${modelParam}` }); return; }

      // Build tool registry（内置工具 + MCP 桥接工具）
      const registry = new ToolRegistry();
      registry.register(searchMemoryTool);
      registry.register(listMemoriesTool);
      registry.register(runDiagnosisTool);
      registry.register(addMemoryTool);
      await bridgeAllMcpTools(registry);

      const brainRoot = resolve(import.meta.dirname, "..");
      const toolMap = new Map(registry.list().map(t => [t.name, t]));

      // Build initial messages with memory injection + conversation history
      const historyMsgs: Array<{ role: string; content: string }> = body.messages ?? [];
      const messages: Array<{ role: string; content: string }> = [];
      try {
        const brainResult = await loadBrainContext(prompt, config.dataDir);
        const { loadActivePatches } = await import("./services/hot-patch.js");
        const { buildBrainSystemPrompt } = await import("./services/brain-context.js");
        const patches = loadActivePatches(brainRoot);
        const systemPrompt = buildBrainSystemPrompt(brainResult.context, patches);
        messages.push({ role: "system", content: systemPrompt });
      } catch { /* degrade gracefully */ }
      for (const m of historyMsgs) {
        if (m.role && m.content) messages.push({ role: m.role, content: m.content });
      }
      messages.push({ role: "user", content: prompt });

      const enableThinking = route.supportsThinking ? (body.enable_thinking ?? false) : undefined;
      const result = await runAgentLoop({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        tools: toolMap,
        toolContext: { brainRoot, dataDir: config.dataDir },
        maxSteps: 10,
        maxTokens: route.maxTokens,
        temperature: 0.7,
        enableThinking,
      });

      json(res, 200, {
        content: result.content,
        steps: result.steps,
        totalTokens: result.totalTokens,
        toolsUsed: result.toolsUsed,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: sessions CRUD — 前端会话服务端持久化
  const sessionsFile = resolve(import.meta.dirname, "..", "data", "admin-sessions.json");

  if (path === "/admin/api/sessions" && req.method === "GET") {
    try {
      const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf-8")) : [];
      json(res, 200, { sessions });
    } catch {
      json(res, 200, { sessions: [] });
    }
    return;
  }

  if (path === "/admin/api/sessions" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const sessions = body.sessions ?? [];
      mkdirSync(resolve(import.meta.dirname, "..", "data"), { recursive: true });
      writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), "utf-8");
      json(res, 200, { ok: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  if (path.startsWith("/admin/api/sessions/") && req.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/admin/api/sessions/".length));
    if (id === "archive") { /* fall through to archive handler */ }
    else {
      try {
        const sessions = existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf-8")) : [];
        const filtered = sessions.filter((s: { id: string }) => s.id !== id);
        writeFileSync(sessionsFile, JSON.stringify(filtered, null, 2), "utf-8");
        json(res, 200, { ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        json(res, 500, { error: msg });
      }
      return;
    }
  }

  // Admin API: session archive — 前端清理的会话消息归档到 brain 记忆
  if (path === "/admin/api/sessions/archive" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const messages: Array<{ role: string; content: string; ts?: string }> = body.messages ?? [];
      if (!messages.length) { json(res, 200, { archived: 0 }); return; }

      const brainRoot = resolve(import.meta.dirname, "..");
      const archiveDir = resolve(brainRoot, "data/session-archives");
      mkdirSync(archiveDir, { recursive: true });

      const date = new Date().toISOString().slice(0, 10);
      const archivePath = resolve(archiveDir, `${date}.jsonl`);
      const entry = {
        sessionId: body.sessionId ?? "unknown",
        title: body.title ?? "",
        mode: body.mode ?? "chat",
        partial: body.partial ?? false,
        messageCount: messages.length,
        messages: messages.map((m: { role: string; content: string; ts?: string }) => ({
          role: m.role,
          content: (m.content ?? "").slice(0, 2000),
          ts: m.ts,
        })),
        archivedAt: new Date().toISOString(),
      };
      appendFileSync(archivePath, JSON.stringify(entry) + "\n", "utf-8");
      json(res, 200, { archived: messages.length, file: `session-archives/${date}.jsonl` });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: MCP status — 返回已连接的 MCP Server 列表和可用工具数
  if (path === "/admin/api/mcp/status" && req.method === "GET") {
    const servers: Record<string, { connected: boolean; toolCount: number; tools: string[] }> = {};
    for (const [name, client] of mcpClients) {
      const bridge = mcpBridgeResults.get(name);
      servers[name] = {
        connected: client.isConnected(),
        toolCount: bridge?.toolCount ?? 0,
        tools: bridge?.toolNames ?? [],
      };
    }
    json(res, 200, { servers, totalConnected: mcpClients.size });
    return;
  }

  // Admin API: MCP reconnect — 重新连接指定 MCP Server
  if (path === "/admin/api/mcp/reconnect" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const serverName: string = body.server ?? "";

      if (serverName) {
        // 重连指定 Server
        const oldClient = mcpClients.get(serverName);
        if (oldClient) {
          oldClient.disconnect();
          mcpClients.delete(serverName);
        }
        mcpBridgeResults.delete(serverName);

        const cfg = mcpConfigs.get(serverName);
        if (!cfg) {
          // 尝试从配置文件重新读取
          const allCfg = getEnabledMcpServers();
          const freshCfg = allCfg[serverName];
          if (!freshCfg) {
            json(res, 400, { error: `MCP Server "${serverName}" not found in config` });
            return;
          }
          await connectMcpServer(serverName, freshCfg);
        } else {
          await connectMcpServer(serverName, cfg);
        }
        json(res, 200, { ok: true, server: serverName, connected: mcpClients.get(serverName)?.isConnected() ?? false });
      } else {
        // 重连所有
        for (const [, client] of mcpClients) {
          client.disconnect();
        }
        mcpClients.clear();
        mcpConfigs.clear();
        mcpBridgeResults.clear();
        await initMcpConnections();
        json(res, 200, { ok: true, totalConnected: mcpClients.size });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Admin API: memory consolidation — 手动触发每日巩固
  if (path === "/admin/api/memory/consolidation" && req.method === "POST") {
    try {
      const { runConsolidation } = await import("./services/memory-consolidation.js");
      const result = await runConsolidation(config.dataDir, config.memoryLLM.consolidation);
      json(res, 200, result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
    return;
  }

  // Health
  if (path === "/health") {
    json(res, 200, { status: "ok", service: "mycc-brain" });
    return;
  }

  // 404
  json(res, 404, { error: "not found" });
});

// ─── 每日巩固定时器（04:00 执行）───
let lastConsolidationDate = "";
function scheduleConsolidation() {
  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().slice(0, 10);
    if (hour === 4 && lastConsolidationDate !== today) {
      lastConsolidationDate = today;
      console.log(`[consolidation] daily run starting at ${now.toISOString()}`);
      try {
        const { runConsolidation } = await import("./services/memory-consolidation.js");
        const result = await runConsolidation(config.dataDir, config.memoryLLM.consolidation);
        console.log(`[consolidation] done:`, JSON.stringify(result));
      } catch (err) {
        console.error(`[consolidation] failed:`, err instanceof Error ? err.message : err);
      }
    }
  }, 60_000); // 每分钟检查一次
}

// 启动服务：先初始化 MCP 连接，再监听端口
initMcpConnections().then(() => {
  server.listen(config.port, "0.0.0.0", () => {
    const memExists = existsSync(resolve(config.dataDir, "memory-items.md"));
    console.log(`\n🧠 mycc-brain v0.3.0 (D4: Agent Loop + MCP)`);
    console.log(`   API:   http://0.0.0.0:${config.port}/v1/chat/completions`);
    console.log(`   Admin: http://0.0.0.0:${config.port}/admin`);
    console.log(`   Data:  ${config.dataDir} (${existsSync(config.dataDir) ? "✅" : "❌ not found"})`);
    console.log(`   Memory: memory-items.md (${memExists ? "✅" : "❌ not found"})`);
    console.log(`   Models: ${Object.keys(config.routes).join(", ")}`);
    console.log(`   MCP:   ${mcpClients.size} server(s) connected`);
    console.log(`   Cron:  consolidation daily @04:00\n`);
    scheduleConsolidation();
  });
});
