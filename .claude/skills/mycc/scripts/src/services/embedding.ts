/**
 * Embedding 服务 — 调用本地 Ollama 生成向量
 *
 * 模型：Qwen3-Embedding-0.6B（512 维 MRL）
 * 端口：Ollama 默认 11434
 * 设计：fire-and-forget，Ollama 不可用时静默返回 null
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as path from "path";

// ============================================================
// 配置
// ============================================================

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://localhost:11434";
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 512;
const EMBED_TIMEOUT_MS = 10_000;

// ============================================================
// 类型
// ============================================================

export interface VectorItem {
  id: string;
  category: string;
  text: string;
  stars: number;
  vector: number[];
}

export interface VectorIndex {
  model: string;
  dimensions: number;
  updated_at: string;
  items: VectorItem[];
}

// ============================================================
// Ollama API
// ============================================================

/** 调用 Ollama /api/embed 获取 embedding 向量 */
export async function embed(text: string): Promise<number[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        truncate: true,
        options: { num_ctx: 512 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return null;

    const data = (await res.json()) as { embeddings?: number[][] };
    const vec = data.embeddings?.[0];
    if (!vec || vec.length === 0) return null;

    // MRL 裁剪到目标维度
    return vec.slice(0, DIMENSIONS);
  } catch {
    return null;
  }
}

/** 批量 embed（逐条调用，避免 Ollama 内存压力） */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await embed(texts[i]));
    onProgress?.(i + 1, texts.length);
  }
  return results;
}

// ============================================================
// 向量索引文件操作
// ============================================================

/** 获取向量索引文件路径 */
export function getIndexPath(cwd: string): string {
  return path.join(cwd, "0-System/memory-vectors.json");
}

/** 读取向量索引（不存在或解析失败返回空索引） */
export function loadVectorIndex(cwd: string): VectorIndex {
  const indexPath = getIndexPath(cwd);
  if (!existsSync(indexPath)) {
    return {
      model: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      updated_at: new Date().toISOString(),
      items: [],
    };
  }

  try {
    const raw = readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as VectorIndex;
  } catch {
    return {
      model: EMBEDDING_MODEL,
      dimensions: DIMENSIONS,
      updated_at: new Date().toISOString(),
      items: [],
    };
  }
}

/** 保存向量索引 */
export function saveVectorIndex(cwd: string, index: VectorIndex): void {
  const indexPath = getIndexPath(cwd);
  const updated: VectorIndex = {
    ...index,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(indexPath, JSON.stringify(updated), "utf-8");
}

// ============================================================
// 向量相似度
// ============================================================

/** 余弦相似度（两个等长 float32 数组） */
export function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 在索引中搜索最相似的 items，返回带分数的结果 */
export function vectorSearch(
  queryVec: number[],
  index: VectorIndex,
  topK: number = 20,
): Array<{ item: VectorItem; similarity: number }> {
  const scored = index.items.map((item) => ({
    item,
    similarity: cosineSim(queryVec, item.vector),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

// ============================================================
// Ollama 健康检查
// ============================================================

/** 检查 Ollama 是否可用且模型已加载 */
export async function isOllamaReady(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);

    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return false;

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = data.models || [];
    return models.some((m) => m.name.includes("qwen3-embedding"));
  } catch {
    return false;
  }
}
