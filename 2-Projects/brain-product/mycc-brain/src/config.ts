import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { DEFAULT_BRAIN_MODEL, DEFAULT_DATA_DIR } from "./env.js";
import { GEMINI_BASE_URL, GEMINI_API_KEY } from "./llm/gemini-client.js";

export interface ModelRoute {
  adapter: "openai-compat";
  brain: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number; // 模型最大输出 token，不设则用适配器默认值 8192
  supportsThinking?: boolean; // 是否支持 enable_thinking 参数（MiniMax/Qwen/DeepSeek/Ollama 支持，Gemini 不支持）
  promptBudgetTokens?: number; // prompt 分层注入预算（<1000=minimal, <3000=standard, 不设=full）
  /**
   * 厂商专属字段透传（非 OpenAI 标准），由 adapter 合并进 request body。
   * 示例：方舟 Coding Plan 用 `{ thinking: { type: "disabled" } }` 关掉 reasoning
   * 以把 doubao-seed-2.0-pro 的 latency 从 18s 降到 5s。
   * 仅限确认兼容该字段的 baseURL，其它第三方 openai-compat endpoint 会被拒绝。
   */
  extraBody?: Record<string, unknown>;
}

export interface MemoryLLMRoute {
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
}

export interface SearchConfig {
  baseURL: string;
  model: string;
  apiKey: string;
  maxTasksPerDay: number;       // 每日最大搜索次数
  minPriority: number;          // 最低优先级阈值
}

export interface BrainConfig {
  port: number;
  brainApiKey: string;
  defaultBrainModel: string;
  dataDir: string;
  routes: Record<string, ModelRoute>;
  memoryLLM: {
    intake: MemoryLLMRoute;
    consolidation: MemoryLLMRoute;
    fallbackIntake?: MemoryLLMRoute;
  };
  search: SearchConfig;
}

function validateDefaultModel(config: BrainConfig): void {
  const model = config.defaultBrainModel;
  if (!model.startsWith("cc-")) {
    throw new Error(`BRAIN_DEFAULT_MODEL must use a brain route (cc-*), got: ${model}`);
  }
  if (!config.routes[model]) {
    throw new Error(`BRAIN_DEFAULT_MODEL route not found: ${model}`);
  }
  const rawModel = model.replace(/^cc-/, "raw-");
  if (!config.routes[rawModel]) {
    throw new Error(`Missing raw counterpart for default brain model: ${rawModel}`);
  }
}

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

// Gemini 中转服务的 baseURL / apiKey 统一由 src/llm/gemini-client.ts 导出
// （GEMINI_BASE_URL / GEMINI_API_KEY），避免 wrapper 端点两处配置。

// MiniMax 在线模型（直连官方 API，OpenAI 兼容格式）
const MINIMAX_BASE = "https://api.minimaxi.com/v1";

// 火山方舟 Coding Plan（OpenAI 兼容，订阅制无并发限流）
// 2026-04-11 上线替代 Gemini proxy 429 blocker，与 knowledge pipeline 共用入口
const ARK_CODING_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";
// 关闭 reasoning_tokens：doubao-seed-2.0-pro 默认开 thinking → latency 18s；关了 5s
const ARK_THINKING_DISABLED: Record<string, unknown> = { thinking: { type: "disabled" } };

export function loadConfig(): BrainConfig {
  const qwenKey = env("QWEN_API_KEY");
  const deepseekKey = env("DEEPSEEK_API_KEY");
  const minimaxKey = env("MINIMAX_API_KEY");
  const ollamaBase = env("OLLAMA_BASE_URL", "http://localhost:11434");

  const result: BrainConfig = {
    port: parseInt(env("BRAIN_PORT", "19080"), 10),
    brainApiKey: env("BRAIN_API_KEY", "sk-brain-dev"),
    defaultBrainModel: DEFAULT_BRAIN_MODEL,
    dataDir: DEFAULT_DATA_DIR,
    routes: {
      "cc-qwen": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3.5-27B-4bit",
        apiKey: "mlx",
        supportsThinking: false,
        promptBudgetTokens: 2500, // standard 模式
      },
      "cc-deepseek": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: deepseekKey,
        supportsThinking: true,
      },
      // cc-local 已移除（Ollama 仅用于视觉，不作为聊天路由）
      "raw-qwen": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3.5-27B-4bit",
        apiKey: "mlx",
        supportsThinking: false,
      },
      "raw-deepseek": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: deepseekKey,
        supportsThinking: true,
      },
      // raw-local 已移除
      // 本地 Ollama 模型（实测 full prompt TTFT 4.3s，替代 MLX 的 86-93s）
      // Ollama 不支持 enable_thinking 参数，用 /no_think 标签关闭 Qwen3 thinking
      "cc-local": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "http://localhost:11434/v1",
        model: "qwen3:4b",
        apiKey: "ollama",
        supportsThinking: false,
      },
      "raw-local": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "http://localhost:11434/v1",
        model: "qwen3:4b",
        apiKey: "ollama",
        supportsThinking: false,
      },
      // Qwen3-30B-A3B（MoE，激活 3B 参数，速度接近 9B，能力接近 27B）
      "cc-qwen30b": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3-30B-A3B-4bit",
        apiKey: "mlx",
        supportsThinking: false,
        promptBudgetTokens: 2500,
      },
      "raw-qwen30b": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3-30B-A3B-4bit",
        apiKey: "mlx",
        supportsThinking: false,
      },
      // cc-gemma4 / raw-gemma4 已移除（Ollama 仅用于视觉）
      // ─── Gemini 在线模型（通过 Gemini Proxy wrapper v5.3）───
      // 唯一事实来源：docs/gemini-calling-rules.md §2.1（6 个生产可用模型）
      // 路由命名：cc- 前缀 = brain 人格注入版，raw- 前缀 = 裸调版
      // 注：cc-gemini-3.1-flash 底层是 gemini-3.1-flash-lite-preview（历史命名，保留以免前端已保存选择失效）

      // 2.5 系列 — 稳定、成本可控、延迟低
      "cc-gemini-2.5-pro": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-2.5-pro",
        apiKey: GEMINI_API_KEY,
      },
      "raw-gemini-2.5-pro": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-2.5-pro",
        apiKey: GEMINI_API_KEY,
      },
      "cc-gemini-2.5-flash": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-2.5-flash",
        apiKey: GEMINI_API_KEY,
      },
      "raw-gemini-2.5-flash": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-2.5-flash",
        apiKey: GEMINI_API_KEY,
      },
      "cc-gemini-2.5-flash-lite": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-2.5-flash-lite",
        apiKey: GEMINI_API_KEY,
        supportsThinking: false, // 2.5-flash-lite 不支持 thinking（docs §3.4）
      },
      "raw-gemini-2.5-flash-lite": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-2.5-flash-lite",
        apiKey: GEMINI_API_KEY,
        supportsThinking: false,
      },

      // 3.x preview 系列 — wrapper 自动路由到 Vertex global endpoint
      "cc-gemini-3-flash": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-3-flash-preview",
        apiKey: GEMINI_API_KEY,
      },
      "raw-gemini-3-flash": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-3-flash-preview",
        apiKey: GEMINI_API_KEY,
      },
      "cc-gemini-3.1-flash": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-3.1-flash-lite-preview",
        apiKey: GEMINI_API_KEY,
      },
      "raw-gemini-3.1-flash": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-3.1-flash-lite-preview",
        apiKey: GEMINI_API_KEY,
      },
      "cc-gemini-3.1-pro": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-3.1-pro-preview",
        apiKey: GEMINI_API_KEY,
      },
      "raw-gemini-3.1-pro": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_BASE_URL,
        model: "gemini-3.1-pro-preview",
        apiKey: GEMINI_API_KEY,
      },
      // MiniMax 在线模型（主力 highspeed ~100 TPS，标准 ~60 TPS）
      "cc-minimax-m2.7-hs": {
        adapter: "openai-compat",
        brain: true,
        baseURL: MINIMAX_BASE,
        model: "MiniMax-M2.7-highspeed",
        apiKey: minimaxKey,
        supportsThinking: true,
      },
      "raw-minimax-m2.7-hs": {
        adapter: "openai-compat",
        brain: false,
        baseURL: MINIMAX_BASE,
        model: "MiniMax-M2.7-highspeed",
        apiKey: minimaxKey,
        supportsThinking: true,
      },
      "cc-minimax-m2.7": {
        adapter: "openai-compat",
        brain: true,
        baseURL: MINIMAX_BASE,
        model: "MiniMax-M2.7",
        apiKey: minimaxKey,
        supportsThinking: true,
      },
      "raw-minimax-m2.7": {
        adapter: "openai-compat",
        brain: false,
        baseURL: MINIMAX_BASE,
        model: "MiniMax-M2.7",
        apiKey: minimaxKey,
        supportsThinking: true,
      },
      // 火山方舟 Coding Plan — 订阅制稳定入口，用于替代 Gemini proxy 429 blocker
      // doubao-seed-2.0-pro: 能力接近 Gemini Flash；thinking 关掉后 TTFT ~5s
      "cc-doubao-seed-pro": {
        adapter: "openai-compat",
        brain: true,
        baseURL: ARK_CODING_BASE,
        model: "doubao-seed-2.0-pro",
        apiKey: env("ARK_CODING_API_KEY"),
        extraBody: ARK_THINKING_DISABLED,
      },
      "raw-doubao-seed-pro": {
        adapter: "openai-compat",
        brain: false,
        baseURL: ARK_CODING_BASE,
        model: "doubao-seed-2.0-pro",
        apiKey: env("ARK_CODING_API_KEY"),
        extraBody: ARK_THINKING_DISABLED,
      },
    },
    memoryLLM: {
      intake: {
        baseURL: "http://localhost:11434/v1",  // Studio Ollama（全量本地，不依赖雷电）
        model: "qwen3:4b",
        apiKey: "ollama",
      },
      consolidation: {
        baseURL: "http://localhost:11434/v1",  // Studio Ollama
        model: "qwen3:4b",
        apiKey: "ollama",
      },
      fallbackIntake: undefined,  // 不需要 fallback，主路径就是本地
    },
    search: {
      baseURL: GEMINI_BASE_URL,
      model: "gemini-2.5-flash",
      apiKey: GEMINI_API_KEY,
      maxTasksPerDay: 5,
      minPriority: 0.2,
    },
  };

  // 加载模型配置覆盖（来自 Admin UI 的配置保存）
  const overridesPath = resolve(import.meta.dirname, "../data/model-config-overrides.json");
  if (existsSync(overridesPath)) {
    try {
      const overrides = JSON.parse(readFileSync(overridesPath, "utf-8"));
      if (overrides.memoryLLM) {
        if (overrides.memoryLLM.intake) Object.assign(result.memoryLLM.intake, overrides.memoryLLM.intake);
        if (overrides.memoryLLM.consolidation) Object.assign(result.memoryLLM.consolidation, overrides.memoryLLM.consolidation);
        if (overrides.memoryLLM.fallbackIntake !== undefined) result.memoryLLM.fallbackIntake = overrides.memoryLLM.fallbackIntake;
      }
    } catch { /* ignore malformed overrides */ }
  }

  validateDefaultModel(result);
  return result;
}
