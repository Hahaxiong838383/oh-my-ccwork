/**
 * list-memories.ts — 记忆分类列表工具
 *
 * 列出指定分类下的记忆条目，或返回所有分类概览。
 */

import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ToolDefinition, ToolContext } from "../services/tool-registry.js";

const inputSchema = z.object({
  category: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

interface CategoryInfo {
  category: string;
  itemCount: number;
}

interface ListMemoriesOutput {
  categories: CategoryInfo[];
  items?: string[];
}

interface MemorySection {
  category: string;
  items: string[];
}

function parseMemoryFile(content: string): MemorySection[] {
  const sections: MemorySection[] = [];
  const lines = content.split("\n");
  let current: MemorySection | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+\[([^\]]+)\]/);
    if (headerMatch) {
      if (current && current.items.length > 0) sections.push(current);
      current = { category: headerMatch[1], items: [] };
      continue;
    }
    if (current && line.startsWith("- ")) {
      current.items.push(line.slice(2).trim());
    }
  }
  if (current && current.items.length > 0) sections.push(current);
  return sections;
}

export const listMemoriesTool: ToolDefinition<Input, ListMemoriesOutput> = {
  name: "list_memories",
  description:
    "列出记忆库的分类概览。传入 category 可查看该分类下的具体条目，不传则返回所有分类及条目数。",
  inputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 3000,

  async execute(input: Input, ctx: ToolContext): Promise<ListMemoriesOutput> {
    const memPath = join(ctx.dataDir, "memory-items.md");
    if (!existsSync(memPath)) {
      return { categories: [] };
    }

    const content = readFileSync(memPath, "utf-8");
    const sections = parseMemoryFile(content);

    if (input.category) {
      const section = sections.find((s) => s.category === input.category);
      if (!section) {
        return {
          categories: [{ category: input.category, itemCount: 0 }],
          items: [],
        };
      }
      return {
        categories: [{ category: section.category, itemCount: section.items.length }],
        items: section.items,
      };
    }

    return {
      categories: sections.map((s) => ({
        category: s.category,
        itemCount: s.items.length,
      })),
    };
  },
};
