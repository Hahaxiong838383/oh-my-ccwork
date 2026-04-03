/**
 * mycc-brain 服务入口
 * :19080 — brain API + admin UI
 */

import http from "http";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "./config.js";
import { BrainApi } from "./brain-api.js";
import { loadBrainContext } from "./services/brain-context.js";
import { listPatches, addPatch, togglePatch, deletePatch } from "./services/hot-patch.js";
import { getTodayStats, getRecentDayStats, getInsights, getHealthMetrics } from "./services/experience-stream.js";
import { getConversationStats } from "./services/conversation.js";

const config = loadConfig();
const brainApi = new BrainApi(config);

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
      let messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "user", content: prompt }];

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

      const result = await chatCompletion({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        messages,
        max_tokens: 200,
      });
      json(res, 200, { content: result.content, usage: result.usage, brain: route.brain });
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
        }).then((r) => ({ ...r, latency: Date.now() - rawStart })),
        chatCompletion({
          baseURL: brainRoute.baseURL,
          apiKey: brainRoute.apiKey,
          model: brainRoute.model,
          messages: brainMessages,
          max_tokens: 8192,
        }).then((r) => ({ ...r, latency: Date.now() - brainStart })),
      ]);

      json(res, 200, {
        raw: { content: rawResult.content, usage: rawResult.usage },
        brain: { content: brainResultResp.content, usage: brainResultResp.usage, injectedCategories, itemCount },
        latency: { raw: rawResult.latency, brain: brainResultResp.latency },
      });
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

  // Health
  if (path === "/health") {
    json(res, 200, { status: "ok", service: "mycc-brain" });
    return;
  }

  // 404
  json(res, 404, { error: "not found" });
});

server.listen(config.port, "0.0.0.0", () => {
  const memExists = existsSync(resolve(config.dataDir, "memory-items.md"));
  console.log(`\n🧠 mycc-brain v0.2.0 (D2: memory injection)`);
  console.log(`   API:   http://0.0.0.0:${config.port}/v1/chat/completions`);
  console.log(`   Admin: http://0.0.0.0:${config.port}/admin`);
  console.log(`   Data:  ${config.dataDir} (${existsSync(config.dataDir) ? "✅" : "❌ not found"})`);
  console.log(`   Memory: memory-items.md (${memExists ? "✅" : "❌ not found"})`);
  console.log(`   Models: ${Object.keys(config.routes).join(", ")}\n`);
});
