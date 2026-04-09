/**
 * soul-loader.ts — SOUL.md 身份内核加载器
 *
 * 每次请求 fresh load SOUL.md，防长 session 人格漂移（Hermes 启发）。
 * 缓存 5 秒避免频繁磁盘读取，但保证几乎每轮都能拿到最新版本。
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── 缓存 ───

let _soulCache: string | null = null;
let _soulCacheTs = 0;
const SOUL_CACHE_TTL = 5_000; // 5 秒缓存，几乎每轮 fresh load

// ─── 核心函数 ───

/**
 * 加载 SOUL.md 内容。
 * 查找顺序：
 *   1. {brainRoot}/data/SOUL.md（部署同步的副本）
 *   2. {brainRoot}/../../0-System/SOUL.md（开发环境，mycc 仓库）
 *
 * 不存在时返回 null（优雅降级，不阻塞主链路）。
 */
export function loadSoul(brainRoot: string): string | null {
  const now = Date.now();
  if (_soulCache !== null && (now - _soulCacheTs) < SOUL_CACHE_TTL) {
    return _soulCache;
  }

  // 路径 1: data/SOUL.md（Studio 部署环境）
  const dataPath = join(brainRoot, "data", "SOUL.md");
  // 路径 2: 开发环境（mycc 仓库根目录下的 0-System/SOUL.md）
  const devPath = join(brainRoot, "..", "..", "0-System", "SOUL.md");

  for (const path of [dataPath, devPath]) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        // 提取核心摘要（6 行），控制 token 预算
        const summary = extractCoreSummary(content);
        _soulCache = summary;
        _soulCacheTs = now;
        return summary;
      } catch {
        // 读取失败，尝试下一个路径
      }
    }
  }

  _soulCache = null;
  _soulCacheTs = now;
  return null;
}

/**
 * 从 SOUL.md 中提取核心摘要段落（控制在 ~500 token 以内）。
 *
 * 提取策略：
 * 1. 优先取「核心摘要」区块（6 行浓缩版，专门为短上下文设计）
 * 2. 如果没有摘要区块，取前 500 字符
 */
function extractCoreSummary(content: string): string {
  // 查找核心摘要区块
  const summaryStart = content.indexOf("【核心摘要");
  if (summaryStart >= 0) {
    // 找到下一个 `---` 分隔线作为结束
    const afterSummary = content.indexOf("---", summaryStart);
    if (afterSummary > summaryStart) {
      const summary = content.slice(summaryStart, afterSummary).trim();
      // 清理 markdown 引用符号，保留纯文本
      const cleaned = summary
        .split("\n")
        .map(line => line.replace(/^>\s?/, "").trim())
        .filter(Boolean)
        .join("\n");
      return `## 身份内核（SOUL.md 摘要）\n${cleaned}`;
    }
  }

  // 降级：取前 500 字符
  return `## 身份内核（SOUL.md）\n${content.slice(0, 500)}`;
}

/**
 * 强制清除缓存（用于测试或手动刷新）
 */
export function clearSoulCache(): void {
  _soulCache = null;
  _soulCacheTs = 0;
}

/**
 * 获取 SOUL.md 加载状态（供 Admin API）
 */
export interface SoulStatus {
  loaded: boolean;
  cachedAt: string | null;
  contentLength: number;
}

export function getSoulStatus(brainRoot: string): SoulStatus {
  const soul = loadSoul(brainRoot);
  return {
    loaded: soul !== null,
    cachedAt: _soulCacheTs > 0 ? new Date(_soulCacheTs).toISOString() : null,
    contentLength: soul?.length ?? 0,
  };
}
