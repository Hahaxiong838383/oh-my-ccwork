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
}

export interface BrainConfig {
  port: number;
  brainApiKey: string;
  dataDir: string;
  routes: Record<string, ModelRoute>;
}

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): BrainConfig {
  const qwenKey = env("QWEN_API_KEY");
  const deepseekKey = env("DEEPSEEK_API_KEY");
  const ollamaBase = env("OLLAMA_BASE_URL", "http://localhost:11434");

  return {
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
      },
      "raw-gemma4": {
        adapter: "openai-compat",
        brain: false,
        baseURL: `${ollamaBase}/v1`,
        model: "gemma4:26b",
        apiKey: "ollama",
      },
    },
  };
}
