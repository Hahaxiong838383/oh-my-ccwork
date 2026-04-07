/**
 * web-search.ts — Web 搜索工具（Gemini Search 适配器）
 *
 * 借鉴 Agent Loop 的 ToolDefinition 接口，复用 openai-compat 协议调 Gemini。
 * Gemini 2.5 Flash 内置 web grounding，无需额外搜索 API。
 *
 * 搜索策略（借鉴 OpenClaw 多层降级）：
 * 1. Gemini Search（内置 grounding，零额外成本）
 * 2. 未来可扩展：Tavily / SearXNG / 无头浏览器等专用 Agent 搜索引擎
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../services/tool-registry.js";

// ─── Input / Output ───

const inputSchema = z.object({
  query: z.string(),
  maxResults: z.number().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface WebSearchResult {
  readonly query: string;
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly sources: readonly string[];
  readonly searchedAt: string;
}

// ─── Search Config ───

export interface SearchConfig {
  readonly baseURL: string;
  readonly model: string;
  readonly apiKey: string;
}

let _searchConfig: SearchConfig | null = null;

/** 注入搜索配置（brain server 启动时调用） */
export function setSearchConfig(config: SearchConfig): void {
  _searchConfig = config;
}

// ─── Gemini Search via OpenAI-compat ───

async function searchViaGemini(
  query: string,
  config: SearchConfig,
): Promise<WebSearchResult> {
  const systemPrompt = [
    "你是知识补全引擎。用户给你一个主题，你需要：",
    "1. 用你的知识（包括 web grounding）搜索相关信息",
    "2. 提炼 3-5 个关键知识点，每个知识点一句话",
    "3. 列出信息来源（URL 或文献名）",
    "",
    "输出格式（严格 JSON）：",
    '{"summary":"一段话总结","keyPoints":["要点1","要点2","要点3"],"sources":["来源1","来源2"]}',
    "",
    "只输出 JSON，不要其他文字。",
  ].join("\n");

  const response = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `搜索并总结：${query}` },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini search failed (${response.status}): ${text}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";

  // 尝试解析 JSON，兜底为纯文本
  try {
    const parsed = JSON.parse(content) as {
      summary?: string;
      keyPoints?: string[];
      sources?: string[];
    };
    return {
      query,
      summary: parsed.summary ?? content,
      keyPoints: parsed.keyPoints ?? [],
      sources: parsed.sources ?? [],
      searchedAt: new Date().toISOString(),
    };
  } catch {
    // Gemini 没返回标准 JSON，用纯文本兜底
    return {
      query,
      summary: content.slice(0, 500),
      keyPoints: [content.slice(0, 200)],
      sources: [],
      searchedAt: new Date().toISOString(),
    };
  }
}

// ─── ToolDefinition（供 Agent Loop 使用） ───

export const webSearchTool: ToolDefinition<Input, WebSearchResult> = {
  name: "web_search",
  description:
    "通过 Gemini Search 搜索网络信息，返回摘要、关键知识点和来源。用于知识补全——当记忆库中缺少某个领域的知识时，主动搜索补全。",
  inputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 30_000,

  async execute(input: Input, _ctx: ToolContext): Promise<WebSearchResult> {
    if (!_searchConfig) {
      throw new Error("Search config not set. Call setSearchConfig() first.");
    }
    return searchViaGemini(input.query, _searchConfig);
  },
};

// ─── 独立搜索函数（不依赖 Agent Loop，供 knowledge-completion 直接调用） ───

export async function webSearch(query: string): Promise<WebSearchResult> {
  if (!_searchConfig) {
    throw new Error("Search config not set. Call setSearchConfig() first.");
  }
  return searchViaGemini(query, _searchConfig);
}
