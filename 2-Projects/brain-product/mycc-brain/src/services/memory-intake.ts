import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { MemoryLLMRoute } from "../config.js";
import { appendFacts, validateFact, type MemoryFact } from "./memory-store.js";

interface IntakeInput {
  userMessage: string;
  assistantReply: string;
  history?: Array<{ role: string; content: string }>;
  dataDir: string;
}

interface IntakeResult {
  facts: MemoryFact[];
  skipReason: string | null;
  model: string;
  latencyMs: number;
  written: number;
  conflicts: number;
}

// 缓存 rules 文件内容（启动后首次读取，之后复用）
let cachedRules: string | null = null;

function loadRules(): string {
  if (cachedRules) return cachedRules;

  // 优先从项目 docs 目录读，fallback 到相对路径
  const candidates = [
    resolve(import.meta.dirname, "../../../docs/memory-rules.md"),
    resolve(import.meta.dirname, "../../docs/memory-rules.md"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      cachedRules = readFileSync(p, "utf-8");
      return cachedRules;
    }
  }

  // 兜底：内联最小规则集
  cachedRules = `你是记忆提取引擎。从对话中提取原子事实，输出 JSON。
六维度：个人信息、偏好变更、事件事实、时间数据、更新/修正、助手信息。
命名空间格式：user/基本、user/偏好、project/技术-飞书 等。
每条事实独立可检索，不含推论。无可提取事实时返回空数组。`;
  return cachedRules;
}

function buildIntakePrompt(input: IntakeInput): string {
  const parts: string[] = [];

  // 最近历史（最多 3 轮，避免 token 过多）
  if (input.history && input.history.length > 0) {
    const recent = input.history.slice(-6); // 最多 3 轮（6 条消息）
    parts.push("## 最近对话历史");
    for (const m of recent) {
      parts.push(`${m.role}: ${m.content}`);
    }
    parts.push("");
  }

  parts.push("## 当前对话");
  parts.push(`user: ${input.userMessage}`);
  parts.push(`assistant: ${input.assistantReply}`);
  parts.push("");
  parts.push("请根据以上对话，按照规则提取原子事实。只输出 JSON，不要其他内容。");

  return parts.join("\n");
}

async function callLLM(
  route: MemoryLLMRoute,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ content: string; model: string }> {
  const { chatCompletion } = await import("../adapters/openai-compat.js");

  const result = await chatCompletion({
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    model: route.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: route.maxTokens ?? 2048,
  });

  return { content: result.content, model: route.model };
}

function parseFactsFromResponse(content: string): { facts: MemoryFact[]; skipReason: string | null } {
  // 尝试提取 JSON（可能被包在 ```json ... ``` 中）
  let jsonStr = content.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // 找 JSON 起始位置（{ 或 [），截取到匹配的闭合括号
  const objStart = jsonStr.indexOf("{");
  const arrStart = jsonStr.indexOf("[");
  const jsonStart = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  if (jsonStart === -1) throw new Error("no JSON found in response");
  jsonStr = jsonStr.slice(jsonStart);

  // 找到匹配的闭合括号，截断多余文本
  const openChar = jsonStr[0];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let endPos = -1;
  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) { endPos = i; break; }
    }
  }
  if (endPos > 0) jsonStr = jsonStr.slice(0, endPos + 1);

  const parsed = JSON.parse(jsonStr);

  // 兼容两种格式：{ "facts": [...] } 或直接 [...]
  const rawFacts: unknown[] = Array.isArray(parsed) ? parsed : (parsed.facts ?? []);

  const facts: MemoryFact[] = (rawFacts as Record<string, unknown>[])
    .map((f: Record<string, unknown>) => ({
      namespace: String(f.namespace ?? ""),
      content: String(f.content ?? ""),
      keywords: Array.isArray(f.keywords) ? f.keywords.map(String) : [],
      dimension: String(f.dimension ?? ""),
      tags: Array.isArray(f.tags) ? f.tags.map(String) : undefined,
      star: typeof f.star === "number" ? f.star : 2,
    }))
    .filter((f: MemoryFact) => validateFact(f) === null);

  return {
    facts,
    skipReason: parsed.skip_reason ?? null,
  };
}

/** 主入口：异步执行记忆提取，fire-and-forget */
export async function runMemoryIntake(
  input: IntakeInput,
  intake: MemoryLLMRoute,
  fallback?: MemoryLLMRoute,
): Promise<IntakeResult | null> {
  const startMs = Date.now();
  const rules = loadRules();
  const userPrompt = buildIntakePrompt(input);

  let content: string;
  let model: string;

  try {
    const result = await callLLM(intake, rules, userPrompt);
    content = result.content;
    model = result.model;
  } catch (primaryErr) {
    if (!fallback) {
      console.error("[memory-intake] primary failed, no fallback:", primaryErr instanceof Error ? primaryErr.message : primaryErr);
      return null;
    }
    console.warn("[memory-intake] primary failed, trying fallback:", primaryErr instanceof Error ? primaryErr.message : primaryErr);
    try {
      const result = await callLLM(fallback, rules, userPrompt);
      content = result.content;
      model = result.model + " (fallback)";
    } catch (fallbackErr) {
      console.error("[memory-intake] fallback also failed:", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
      return null;
    }
  }

  // 解析 LLM 输出
  let facts: MemoryFact[];
  let skipReason: string | null;
  try {
    const parsed = parseFactsFromResponse(content);
    facts = parsed.facts;
    skipReason = parsed.skipReason;
  } catch (parseErr) {
    console.error("[memory-intake] JSON parse failed:", parseErr instanceof Error ? parseErr.message : parseErr, "raw:", content.slice(0, 200));
    return null;
  }

  // 写入独立的 intake 文件，避免被 rsync 覆盖
  const { written, conflicts } = facts.length > 0
    ? appendFacts(input.dataDir, facts, "memory-items-intake.md")
    : { written: 0, conflicts: 0 };

  const latencyMs = Date.now() - startMs;

  if (facts.length > 0) {
    console.log(`[memory-intake] extracted ${facts.length} facts (${conflicts} conflicts) via ${model} in ${latencyMs}ms`);
  }

  return { facts, skipReason, model, latencyMs, written, conflicts };
}
