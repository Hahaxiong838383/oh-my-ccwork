/**
 * add-memory.ts — 记忆写入工具
 *
 * 当用户要求记住某件事时，通过此工具将信息写入 user-memories.jsonl。
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../services/tool-registry.js";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const inputSchema = z.object({
  category: z.string().describe("记忆分类，如：个人偏好、工作信息、重要事件"),
  content: z.string().describe("要记住的内容"),
  keywords: z.array(z.string()).describe("便于检索的关键词"),
});

type Input = z.infer<typeof inputSchema>;

interface AddMemoryOutput {
  success: boolean;
  message: string;
}

export const addMemoryTool: ToolDefinition<Input, AddMemoryOutput> = {
  name: "add_memory",
  description: "记住用户告诉你的信息。当用户要求记住某件事时调用此工具。",
  inputSchema,
  isReadOnly: false,
  isDestructive: false,
  timeoutMs: 3000,

  async execute(input: Input, ctx: ToolContext): Promise<AddMemoryOutput> {
    const entry = {
      ts: new Date().toISOString(),
      category: input.category,
      content: input.content,
      keywords: input.keywords,
    };

    const filePath = join(ctx.dataDir, "user-memories.jsonl");
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");

    return {
      success: true,
      message: `已记住：${input.content.slice(0, 50)}...`,
    };
  },
};
