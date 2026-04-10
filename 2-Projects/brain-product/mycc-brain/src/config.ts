import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { DEFAULT_BRAIN_MODEL, DEFAULT_DATA_DIR } from "./env.js";

export interface ModelRoute {
  adapter: "openai-compat";
  brain: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number; // 模型最大输出 token，不设则用适配器默认值 8192
  supportsThinking?: boolean; // 是否支持 enable_thinking 参数（MiniMax/Qwen/DeepSeek/Ollama 支持，Gemini 不支持）
  promptBudgetTokens?: number; // prompt 分层注入预算（<1000=minimal, <3000=standard, 不设=full）
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

// Gemini 中转服务（OpenAI 兼容格式）
const GEMINI_PROXY_BASE = "http://23.226.135.149:4000/v1";

// MiniMax 在线模型（直连官方 API，OpenAI 兼容格式）
const MINIMAX_BASE = "https://api.minimaxi.com/v1";

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
      // Gemini 在线模型（通过中转服务）
      "cc-gemini-2.5-flash": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_PROXY_BASE,
        model: "gemini-2.5-flash",
        apiKey: env("GEMINI_PROXY_KEY"),
      },
      "raw-gemini-2.5-flash": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_PROXY_BASE,
        model: "gemini-2.5-flash",
        apiKey: env("GEMINI_PROXY_KEY"),
      },
      "cc-gemini-3.1-flash": {
        adapter: "openai-compat",
        brain: true,
        baseURL: GEMINI_PROXY_BASE,
        model: "gemini-3.1-flash-lite-preview",
        apiKey: env("GEMINI_PROXY_KEY"),
      },
      "raw-gemini-3.1-flash": {
        adapter: "openai-compat",
        brain: false,
        baseURL: GEMINI_PROXY_BASE,
        model: "gemini-3.1-flash-lite-preview",
        apiKey: env("GEMINI_PROXY_KEY"),
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
      baseURL: GEMINI_PROXY_BASE,
      model: "gemini-2.5-flash",
      apiKey: env("GEMINI_PROXY_KEY"),
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
