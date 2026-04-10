/**
 * allowlist.ts — 从 knowledge-allowlist.json 加载并校验 space 白名单
 *
 * 设计决策：Spike 阶段用 JSON（非 YAML），理由：
 *   1. 零新依赖（avoid adding yaml parser for 10 lines of config）
 *   2. Zod 直接校验 JSON.parse 结果，类型安全
 *   3. 偏离 HANDOFF 原设计 .yaml.template，改为 .template.json
 *
 * 文件不存在时返回空白名单（不抛错），便于 CI / fresh-clone 场景。
 */
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Allowlist, AllowlistEntry } from "./types.js";

const allowlistEntrySchema = z.object({
  space_id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  root_tokens: z.array(z.string()),
});

const allowlistFileSchema = z.object({
  spaces: z.array(allowlistEntrySchema),
});

/** 加载 allowlist；文件不存在 → 空白名单。解析/校验失败 → 抛出 zod error */
export function loadAllowlist(filePath: string): Allowlist {
  if (!existsSync(filePath)) {
    return { spaces: [] };
  }
  const raw = readFileSync(filePath, "utf-8");
  const parsed = allowlistFileSchema.parse(JSON.parse(raw));
  return {
    spaces: parsed.spaces.map(
      (s): AllowlistEntry => ({
        spaceId: s.space_id,
        name: s.name,
        enabled: s.enabled,
        rootTokens: s.root_tokens,
      }),
    ),
  };
}

/** 判断给定 space_id 是否在启用的白名单中 */
export function isSpaceAllowed(
  allowlist: Allowlist,
  spaceId: string,
): boolean {
  return allowlist.spaces.some((s) => s.enabled && s.spaceId === spaceId);
}

/** 列出所有启用的 space_id（crawler 遍历时用） */
export function getEnabledSpaceIds(allowlist: Allowlist): readonly string[] {
  return allowlist.spaces.filter((s) => s.enabled).map((s) => s.spaceId);
}

/** 取单个 space 的配置（用于 crawler 读 rootTokens 约束） */
export function getSpaceEntry(
  allowlist: Allowlist,
  spaceId: string,
): AllowlistEntry | undefined {
  return allowlist.spaces.find((s) => s.spaceId === spaceId);
}
