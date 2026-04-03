/**
 * rate-limiter.ts — 简易并发 + 速率限制
 *
 * DashScope: 30 RPM → 并发 2 + 2s 间隔
 * Gemini: 相对宽松 → 并发 3
 */

export function createLimiter(concurrency: number, intervalMs: number) {
  let running = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length === 0) return;
    if (running >= concurrency) return;
    running++;
    const resolve = queue.shift()!;
    resolve();
  }

  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      next();
    });

    try {
      const result = await fn();
      return result;
    } finally {
      running--;
      if (intervalMs > 0) {
        setTimeout(() => next(), intervalMs);
      } else {
        next();
      }
    }
  };
}

export const dashscopeLimit = createLimiter(2, 2000);
export const geminiLimit = createLimiter(3, 500);
