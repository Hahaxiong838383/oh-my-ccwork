/**
 * ollama-vision.ts — Ollama 视觉模型 API 封装
 *
 * 通过 HTTP 调用本地 Ollama 的 minicpm-v 模型，
 * 支持按需视觉问答（传入图片 + 问题，返回自然语言描述）。
 */

import { readFileSync } from "fs";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "minicpm-v";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OllamaVisionOptions {
  ollamaUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export async function askOllamaVision(
  imagePath: string,
  question: string,
  options?: OllamaVisionOptions,
): Promise<string> {
  const ollamaUrl = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options?.model ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const imageBuffer = readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString("base64");

  const payload = JSON.stringify({
    model,
    prompt: question,
    images: [imageBase64],
    stream: false,
    options: { num_predict: 300 },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as { response?: string };
    return (result.response ?? "").trim();
  } finally {
    clearTimeout(timer);
  }
}
