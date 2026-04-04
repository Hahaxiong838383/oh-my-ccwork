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

export function loadConfig(): BrainConfig {
  const qwenKey = env("QWEN_API_KEY");
  const deepseekKey = env("DEEPSEEK_API_KEY");
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
      },
      "cc-deepseek": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: deepseekKey,
      },
      "cc-local": {
        adapter: "openai-compat",
        brain: true,
        baseURL: `${ollamaBase}/v1`,
        model: "qwen2.5:7b",
        apiKey: "ollama",
      },
      "raw-qwen": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
      },
      "raw-deepseek": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: deepseekKey,
      },
      "raw-local": {
        adapter: "openai-compat",
        brain: false,
        baseURL: `${ollamaBase}/v1`,
        model: "qwen2.5:7b",
        apiKey: "ollama",
      },
      "cc-mlx": {
        adapter: "openai-compat",
        brain: true,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3.5-27B-4bit",
        apiKey: "mlx",
      },
      "raw-mlx": {
        adapter: "openai-compat",
        brain: false,
        baseURL: "http://localhost:8000/v1",
        model: "mlx-community/Qwen3.5-27B-4bit",
        apiKey: "mlx",
      },
      "cc-gemma4": {
        adapter: "openai-compat",
        brain: true,
        baseURL: `${ollamaBase}/v1`,
        model: "gemma4:26b",
        apiKey: "ollama",
        maxTokens: 32768,
      },
      "raw-gemma4": {
        adapter: "openai-compat",
        brain: false,
        baseURL: `${ollamaBase}/v1`,
        model: "gemma4:26b",
        apiKey: "ollama",
        maxTokens: 32768,
      },
    },
    memoryLLM: {
      intake: {
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
      },
      consolidation: {
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3.5-27b",
        apiKey: qwenKey,
      },
      fallbackIntake: undefined,
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
