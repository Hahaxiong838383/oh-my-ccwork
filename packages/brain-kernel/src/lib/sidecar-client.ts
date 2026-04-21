/**
 * sidecar-client.ts — Rust Sidecar (fastembed + sqlite-vec) HTTP 客户端封装
 *
 * 接口契约（对齐 packages/rust-sidecar/src/main.rs）：
 *   GET  /health  → { status, version, uptime_ms, model_loaded }
 *   POST /embed   → { embeddings: number[][], dimensions }
 *   POST /search  → { results: [{ truth_id, distance }] }
 *   POST /index   → { indexed: true, truth_id }
 *
 * 设计原则：
 * - 所有方法 timeout 明确，避免 Sidecar 假死阻塞主流程
 * - 失败显式（Promise reject），由调用方决定是否降级
 * - health() 例外：返回 boolean 而非抛，作为快速探测
 */

// ============================================================
// 类型
// ============================================================

export interface SidecarSearchHit {
  readonly truthId: string;
  readonly distance: number;
}

export interface SidecarClient {
  /** 健康探测。< HEALTH_TIMEOUT_MS 内返回 true 表示 Sidecar 可用且 model_loaded。 */
  health(): Promise<boolean>;

  /** 批量生成 embedding。单批最多 32 条（由 Sidecar 限制）。 */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;

  /** 向量检索。query 维度必须和 Sidecar embedder 一致（fastembed 默认 384）。 */
  search(query: readonly number[], limit: number): Promise<readonly SidecarSearchHit[]>;

  /** 异步索引：Sidecar 内部 embed + upsert。失败时 reject。 */
  index(truthId: string, text: string): Promise<boolean>;
}

// ============================================================
// 默认常量
// ============================================================

const DEFAULT_URL = 'http://127.0.0.1:19081';
const HEALTH_TIMEOUT_MS = 150;
const EMBED_TIMEOUT_MS = 5_000;
const SEARCH_TIMEOUT_MS = 2_000;
const INDEX_TIMEOUT_MS = 5_000;
const MAX_BATCH = 32;

// ============================================================
// HTTP helper
// ============================================================

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// Default HTTP 实现
// ============================================================

class HttpSidecarClient implements SidecarClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(
        `${this.#baseUrl}/health`,
        { method: 'GET' },
        HEALTH_TIMEOUT_MS,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as { model_loaded?: boolean };
      return data.model_loaded === true;
    } catch {
      return false;
    }
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) {
      throw new Error('embed: texts array is empty');
    }
    if (texts.length > MAX_BATCH) {
      throw new Error(`embed: max ${MAX_BATCH} texts per batch, got ${texts.length}`);
    }

    const res = await fetchWithTimeout(
      `${this.#baseUrl}/embed`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      },
      EMBED_TIMEOUT_MS,
    );

    if (!res.ok) {
      throw new Error(`embed: sidecar returned ${res.status}`);
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error('embed: invalid response shape');
    }
    return data.embeddings;
  }

  async search(query: readonly number[], limit: number): Promise<readonly SidecarSearchHit[]> {
    if (query.length === 0) {
      throw new Error('search: query vector is empty');
    }

    const res = await fetchWithTimeout(
      `${this.#baseUrl}/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
      },
      SEARCH_TIMEOUT_MS,
    );

    if (!res.ok) {
      throw new Error(`search: sidecar returned ${res.status}`);
    }

    const data = (await res.json()) as {
      results?: Array<{ truth_id?: string; distance?: number }>;
    };
    if (!Array.isArray(data.results)) {
      throw new Error('search: invalid response shape');
    }
    return data.results.flatMap(r => {
      if (typeof r.truth_id !== 'string' || typeof r.distance !== 'number') return [];
      return [{ truthId: r.truth_id, distance: r.distance }];
    });
  }

  async index(truthId: string, text: string): Promise<boolean> {
    if (!truthId || !text) {
      throw new Error('index: truthId and text are required');
    }

    const res = await fetchWithTimeout(
      `${this.#baseUrl}/index`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ truth_id: truthId, text }),
      },
      INDEX_TIMEOUT_MS,
    );

    if (!res.ok) {
      throw new Error(`index: sidecar returned ${res.status}`);
    }

    const data = (await res.json()) as { indexed?: boolean };
    return data.indexed === true;
  }
}

// ============================================================
// 单例 + 注入口（供测试 mock）
// ============================================================

let clientInstance: SidecarClient | null = null;

/** 返回默认（或已注入的）Sidecar 客户端。线程安全：Node 单线程。 */
export function getSidecarClient(): SidecarClient {
  if (!clientInstance) {
    const url = process.env.EVODESK_SIDECAR_URL ?? DEFAULT_URL;
    clientInstance = new HttpSidecarClient(url);
  }
  return clientInstance;
}

/** 仅用于测试：注入 mock 实现。传 null 可恢复默认。 */
export function setSidecarClientForTesting(client: SidecarClient | null): void {
  clientInstance = client;
}

/**
 * 基于 compiled_truths 重建 Sidecar 向量索引（fire-and-forget）。
 * Sidecar 不可用时静默跳过，不影响 truth 写入主流程。
 */
export function reindexTruthAsync(truthId: string, statement: string): void {
  const client = getSidecarClient();
  client
    .health()
    .then(ok => {
      if (!ok) {
        // 静默：Sidecar 离线是正常场景
        return;
      }
      return client.index(truthId, statement).then(() => undefined);
    })
    .catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[vector-index] failed truth=${truthId}: ${msg}`);
    });
}
