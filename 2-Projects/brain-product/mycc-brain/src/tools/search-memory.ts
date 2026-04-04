/**
 * search-memory.ts — 记忆搜索工具
 *
 * 封装 brain-context.ts 的 loadBrainContext，
 * 供 Agent Loop 通过 tool calling 调用。
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../services/tool-registry.js";
import { loadBrainContext } from "../services/brain-context.js";

const inputSchema = z.object({
  query: z.string(),
});

type Input = z.infer<typeof inputSchema>;

interface SearchMemoryOutput {
  matchedCategories: string[];
  itemCount: number;
  contextPreview: string;
}

export const searchMemoryTool: ToolDefinition<Input, SearchMemoryOutput> = {
  name: "search_memory",
  description:
    "根据查询语句搜索记忆库，返回匹配的分类、条目数量和上下文预览。支持关键词、TF-IDF、FTS、向量四路检索。",
  inputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 5000,

  async execute(input: Input, ctx: ToolContext): Promise<SearchMemoryOutput> {
    const result = await loadBrainContext(input.query, ctx.dataDir);
    return {
      matchedCategories: result.matchedCategories,
      itemCount: result.itemCount,
      contextPreview: result.context.slice(0, 800),
    };
  },
};
