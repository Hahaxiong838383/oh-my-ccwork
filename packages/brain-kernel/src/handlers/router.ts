import type { IncomingMessage, ServerResponse } from "node:http";
import type { FlowState } from "@evodesk/shared";
import { getCircuitMetrics, selectWithFallback } from "../providers/fallback-chain.js";
import {
  K_PROVIDER_CONFIG_PATH,
  Registry,
  type ProviderConfig,
  type SlotName,
} from "../providers/registry.js";
import {
  FLOW_POLICY,
  K_ROUTER_FAIL_CLOSED_CODE,
  K_ROUTER_FLOW_STATES,
} from "../providers/router.js";
import { getDecisionStats } from "../providers/telemetry.js";
import { jsonResponse } from "./_shared.js";

const SLOT_NAMES: readonly SlotName[] = ["chat", "extract", "embed", "vision", "tool_use"];

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

let registryPromise: Promise<Registry> | null = null;

function getRegistry(): Promise<Registry> {
  if (!registryPromise) {
    registryPromise = (async () => {
      const registry = new Registry();
      try {
        await registry.loadFromYaml(
          process.env.EVODESK_PROVIDER_CONFIG_PATH ?? K_PROVIDER_CONFIG_PATH,
        );
      } catch {
        await registry.register(defaultProviderConfig());
        return registry;
      }
      if (registry.list().length === 0) {
        await registry.register(defaultProviderConfig());
      }
      return registry;
    })();
  }
  return registryPromise;
}

/** 仅测试使用 —— 重置 registry 单例 */
export function resetRouterRegistryForTesting(): void {
  registryPromise = null;
}

export async function handleRouter(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (method !== "GET") return false;

  if (url === "/v1/router/stats" || url.startsWith("/v1/router/stats?")) {
    jsonResponse(res, 200, {
      ...getDecisionStats(),
      circuitMetrics: getCircuitMetrics(),
    });
    return true;
  }

  if (url === "/v1/router/policy" || url.startsWith("/v1/router/policy?")) {
    jsonResponse(res, 200, { policy: FLOW_POLICY });
    return true;
  }

  if (url.startsWith("/v1/router/decisions")) {
    const parsed = new URL(url, "http://127.0.0.1");
    const flow = parsed.searchParams.get("flow") as FlowState | null;
    if (!flow || !K_ROUTER_FLOW_STATES.includes(flow)) {
      jsonResponse(res, 400, {
        error: "INVALID_FLOW",
        message: "flow must be one of FLOW|BOREDOM|ANXIETY|APATHY",
      });
      return true;
    }
    try {
      const registry = await getRegistry();
      const entries = await Promise.all(
        SLOT_NAMES.map(async (slot) => {
          try {
            const result = await selectWithFallback(registry, flow, slot);
            return [slot, {
              provider: result.provider,
              fallbackPath: result.fallbackPath,
              attempts: result.attempts,
              durationMs: result.durationMs,
            }] as const;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            const errorCode = message === K_ROUTER_FAIL_CLOSED_CODE ? K_ROUTER_FAIL_CLOSED_CODE : "SLOT_ERROR";
            return [slot, { error: errorCode, message }] as const;
          }
        }),
      );
      const decisions = Object.fromEntries(entries);
      jsonResponse(res, 200, { flow, decisions });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jsonResponse(res, 500, { error: "INTERNAL_ERROR", message });
    }
    return true;
  }

  if (!url.startsWith("/v1/router/select")) return false;

  const parsed = new URL(url, "http://127.0.0.1");
  const flow = parsed.searchParams.get("flow") as FlowState | null;
  const slot = parsed.searchParams.get("slot") as SlotName | null;

  if (!flow || !K_ROUTER_FLOW_STATES.includes(flow)) {
    jsonResponse(res, 400, {
      error: "INVALID_FLOW",
      message: "flow must be one of FLOW|BOREDOM|ANXIETY|APATHY",
    });
    return true;
  }
  if (!slot || !SLOT_NAMES.includes(slot)) {
    jsonResponse(res, 400, {
      error: "INVALID_SLOT",
      message: "slot must be one of chat|extract|embed|vision|tool_use",
    });
    return true;
  }

  try {
    const registry = await getRegistry();
    const result = await selectWithFallback(registry, flow, slot);
    jsonResponse(res, 200, {
      provider: result.provider,
      fallbackPath: result.fallbackPath,
      attempts: result.attempts,
      durationMs: result.durationMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === K_ROUTER_FAIL_CLOSED_CODE) {
      jsonResponse(res, 503, {
        error: K_ROUTER_FAIL_CLOSED_CODE,
        message: "No available provider",
      });
    } else {
      jsonResponse(res, 500, { error: "INTERNAL_ERROR", message });
    }
  }
  return true;
}
