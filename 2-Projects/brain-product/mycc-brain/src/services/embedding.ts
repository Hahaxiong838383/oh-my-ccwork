/** embedding.ts — Ollama embedding 调用封装 */

const DEFAULT_MODEL = "qwen3-embedding:0.6b";
export const EMBEDDING_DIM = 1024;
const TIMEOUT_MS = 10_000;

function getOllamaBase(override?: string): string {
  return override ?? process.env.OLLAMA_HOST ?? "http://localhost:11434";
}

export async function embed(
  text: string,
  ollamaBase?: string,
): Promise<number[] | null> {
  const base = getOllamaBase(ollamaBase);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${base}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_MODEL, input: text }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`[embedding] Ollama returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { embeddings?: number[][] };
    const vec = data.embeddings?.[0];
    if (!vec || vec.length === 0) {
      console.error("[embedding] empty embeddings response");
      return null;
    }
    if (vec.length !== EMBEDDING_DIM) {
      console.warn(
        `[embedding] dimension mismatch: got ${vec.length}, expected ${EMBEDDING_DIM} (model=${DEFAULT_MODEL}). Returning null.`
      );
      return null;
    }
    return vec;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[embedding] Ollama request timed out");
    } else {
      console.error("[embedding] embed failed:", err);
    }
    return null;
  }
}

export async function isOllamaReady(ollamaBase?: string): Promise<boolean> {
  const base = getOllamaBase(ollamaBase);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);

    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
