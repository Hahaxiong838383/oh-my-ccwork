import { config } from "dotenv";
import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

config({ path: resolve(import.meta.dirname, "../.env") });

export interface ModelRoute {
  adapter: "openai-compat";
  brain: boolean;
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number; // 模型最大输出 token，不设则用适配器默认值 8192
  supportsThinking?: boolean; // 是否支持 enable_thinking 参数（MiniMax/Qwen/DeepSeek/Ollama 支持，Gemini 不支持）
}

export interface MemoryLLMRoute {
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
}

export interface BrainConfig {
  port: number;
  brainApiKey: string;
  dataDir: string;
  routes: Record<string, ModelRoute>;
  memoryLLM: {
    intake: MemoryLLMRoute;
    consolidation: MemoryLLMRoute;
    fallbackIntake?: MemoryLLMRoute;
  };
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
    dataDir: env("DATA_DIR", resolve(import.meta.dirname, "../../mycc-data/0-System")),
    routes: {
      "cc-qwen": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
        supportsThinking: true,
      },
      "cc-deepseek": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: deepseekKey,
        supportsThinking: true,
      },
      "cc-local": {
        adapter: "openai-compat",
        brain: true,
        baseURL: `${ollamaBase}/v1`,
        model: "qwen2.5:7b",
        apiKey: "ollama",
        supportsThinking: true,
      },
      "raw-qwen": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
        supportsThinking: true,
      },
      "raw-deepseek": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: deepseekKey,
        supportsThinking: true,
      },
      "raw-local": {
        adapter: "openai-compat",
        brain: false,
        baseURL: `${ollamaBase}/v1`,
        model: "qwen2.5:7b",
        apiKey: "ollama",
        supportsThinking: true,
      },
      "cc-mlx": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3.5-27B-4bit",
        apiKey: "mlx",
        supportsThinking: true,
      },
      "raw-mlx": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3.5-27B-4bit",
        apiKey: "mlx",
        supportsThinking: true,
      },
      "cc-gemma4": {
        adapter: "openai-compat",
        brain: true,
        baseURL: `${ollamaBase}/v1`,
        model: "gemma4:26b",
        apiKey: "ollama",
        maxTokens: 32768,
        supportsThinking: true,
      },
      "raw-gemma4": {
        adapter: "openai-compat",
        brain: false,
        baseURL: `${ollamaBase}/v1`,
        model: "gemma4:26b",
        apiKey: "ollama",
        maxTokens: 32768,
        supportsThinking: true,
      },
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
        baseURL: "http://localhost:8001/v1",
        model: "mlx-community/Qwen3.5-4B-MLX-4bit",
        apiKey: "mlx",
      },
      consolidation: {
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
      },
      fallbackIntake: qwenKey ? {
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
      } : undefined,
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

  return result;
}
