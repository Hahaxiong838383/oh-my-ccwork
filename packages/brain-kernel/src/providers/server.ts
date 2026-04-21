import { createServer, type Server, type ServerResponse } from "node:http";
import type { FlowState } from "@evodesk/shared";
import { selectWithFallback } from "./fallback-chain.js";
import {
  K_PROVIDER_CONFIG_PATH,
  Registry,
  type ProviderConfig,
  type SlotName,
} from "./registry.js";
import { K_ROUTER_FAIL_CLOSED_CODE, K_ROUTER_FLOW_STATES } from "./router.js";
import { getDecisionStats } from "./telemetry.js";

const SLOT_NAMES: readonly SlotName[] = ["chat", "extract", "embed", "vision", "tool_use"];

function writeJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: code, message });
}

function defaultProviderConfig(): ProviderConfig {
  return {
    id: "local-fallback",
    kind: "local",
    enabled: true,
    priority: 100,
    capabilities: {
      chat: { enabled: true, input: "text", output: "text" },
      extract: { enabled: true, input: "text", output: "json" },
      embed: { enabled: true, input: "text", output: "embedding" },
      vision: { enabled: true, input: "image", output: "text" },
      tool_use: { enabled: true, input: "text", output: "json" },
    },
    models: ["local-default"],
    cost: { input_per_1k: 0, output_per_1k: 0, currency: "USD" },
    latency_p95: 20,
    auth_env: ["EVODESK_FAKE_KEY"],
    timeout_ms: 500,
    tags: ["fallback", "local"],
  };
}

async function bootstrapRegistry(): Promise<Registry> {
  const registry = new Registry();
  try {
    await registry.loadFromYaml(process.env.EVODESK_PROVIDER_CONFIG_PATH ?? K_PROVIDER_CONFIG_PATH);
  } catch {
    await registry.register(defaultProviderConfig());
    return registry;
  }

  if (registry.list().length === 0) {
    await registry.register(defaultProviderConfig());
  }
  return registry;
}

export function startServer(port: number): Server {
  const registryReady = bootstrapRegistry();
  const server = createServer(async (req, res) => {
    if ((req.method ?? "GET") !== "GET") {
      writeError(res, 405, "METHOD_NOT_ALLOWED", "Only GET is supported");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/v1/providers/stats") {
      writeJson(res, 200, getDecisionStats());
      return;
    }

    if (url.pathname !== "/v1/providers/select") {
      writeError(res, 404, "NOT_FOUND", "Endpoint not found");
      return;
    }

    const flow = url.searchParams.get("flow") as FlowState | null;
    const slot = url.searchParams.get("slot") as SlotName | null;
    if (!flow || !K_ROUTER_FLOW_STATES.includes(flow)) {
      writeError(res, 400, "INVALID_FLOW", "flow must be one of FLOW|BOREDOM|ANXIETY|APATHY");
      return;
    }
    if (!slot || !SLOT_NAMES.includes(slot)) {
      writeError(res, 400, "INVALID_SLOT", "slot must be one of chat|extract|embed|vision|tool_use");
      return;
    }

    try {
      const registry = await registryReady;
      const result = await selectWithFallback(registry, flow, slot);
      writeJson(res, 200, {
        provider: result.provider,
        fallbackPath: result.fallbackPath,
        durationMs: result.durationMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message === K_ROUTER_FAIL_CLOSED_CODE) {
        writeError(res, 503, K_ROUTER_FAIL_CLOSED_CODE, "No available provider");
        return;
      }
      writeError(res, 500, "INTERNAL_ERROR", message);
    }
  });

  server.listen(port);
  return server;
}
