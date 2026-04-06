/**
 * agent-loop.ts — Agent Loop 核心模块
 *
 * 手写 Agent Loop，基于 OpenAI function calling 协议。
 * 核心流程：调用 LLM(messages + tools) → 检查 tool_calls →
 *   有 → 执行工具 → 结果放回 messages → 再调 LLM（循环）
 *   无 → 返回最终文本回复
 */

import { ToolRegistry } from "./tool-registry.js";
import type { ToolDefinition, ToolContext } from "./tool-registry.js";

// ─── Types ───

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface AgentLoopOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: Map<string, ToolDefinition>;
  toolContext: ToolContext;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  enableThinking?: boolean;
  onStep?: (step: AgentStep) => void;
}

export interface AgentStep {
  stepNumber: number;
  type: "llm_call" | "tool_exec";
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  content?: string;
  usage?: { total_tokens: number };
  durationMs: number;
}

export interface AgentLoopResult {
  content: string;
  steps: AgentStep[];
  totalTokens: number;
  toolsUsed: string[];
}

// ─── Tool Format Conversion ───

function toOpenAIToolsFormat(
  tools: Map<string, ToolDefinition>,
): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
  const registry = new ToolRegistry();
  for (const tool of tools.values()) {
    registry.register(tool);
  }
  return registry.toOpenAITools();
}

// ─── LLM Call with Tools Support ───

const TOOL_EXEC_TIMEOUT_MS = 30_000;

async function chatCompletionWithTools(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  enableThinking?: boolean;
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
}): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
  usage: { total_tokens: number };
}> {
  const url = `${opts.baseURL}/chat/completions`;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
    ...(opts.enableThinking != null && { enable_thinking: opts.enableThinking }),
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e: unknown) {
    const cause = e instanceof Error && "cause" in e ? (e as any).cause : undefined;
    const detail = cause?.message ?? cause?.code ?? (e instanceof Error ? e.message : String(e));
    throw new Error(`Network error reaching ${url.split("/v1")[0]}: ${detail}`);
  }

  if (!upstream.ok) {
    throw new Error(`Upstream ${upstream.status}: ${await upstream.text()}`);
  }

  const data = (await upstream.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  // Gemma 4 thinking 模式：content 为空时 fallback 到 reasoning
  const content = message?.content || (message as any)?.reasoning || null;

  return {
    content,
    toolCalls: message?.tool_calls ?? [],
    usage: { total_tokens: data.usage?.total_tokens ?? 0 },
  };
}

// ─── Tool Execution with Timeout ───

async function executeToolWithTimeout(
  tool: ToolDefinition,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const timeoutMs = tool.timeoutMs || TOOL_EXEC_TIMEOUT_MS;

  const result = await Promise.race([
    tool.execute(input, ctx),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${tool.name}" timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  return result;
}

// ─── Core Agent Loop ───

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = opts.maxSteps ?? 10;
  const maxTokens = opts.maxTokens ?? 8192;
  const temperature = opts.temperature ?? 0.7;

  const messages: ChatMessage[] = [...opts.messages];
  const openaiTools = toOpenAIToolsFormat(opts.tools);
  const steps: AgentStep[] = [];
  const toolsUsedSet = new Set<string>();
  let totalTokens = 0;
  let stepNumber = 0;

  while (stepNumber < maxSteps) {
    // ── LLM Call ──
    const llmStart = Date.now();
    const llmResult = await chatCompletionWithTools({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      enableThinking: opts.enableThinking,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
    });
    const llmDuration = Date.now() - llmStart;

    totalTokens += llmResult.usage.total_tokens;
    stepNumber += 1;

    const llmStep: AgentStep = {
      stepNumber,
      type: "llm_call",
      content: llmResult.content ?? undefined,
      usage: llmResult.usage,
      durationMs: llmDuration,
    };
    steps.push(llmStep);
    opts.onStep?.(llmStep);

    // ── No tool_calls → done ──
    if (llmResult.toolCalls.length === 0) {
      return {
        content: llmResult.content ?? "",
        steps,
        totalTokens,
        toolsUsed: [...toolsUsedSet],
      };
    }

    // ── Append assistant message with tool_calls ──
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: llmResult.content,
      tool_calls: llmResult.toolCalls,
    };
    messages.push(assistantMsg);

    // ── Execute tools: readonly in parallel, write sequentially ──
    const readOnlyCalls: ToolCall[] = [];
    const writeCalls: ToolCall[] = [];

    for (const tc of llmResult.toolCalls) {
      const tool = opts.tools.get(tc.function.name);
      if (tool?.isReadOnly) {
        readOnlyCalls.push(tc);
      } else {
        writeCalls.push(tc);
      }
    }

    // Execute readonly tools in parallel
    const readOnlyResults = await Promise.all(
      readOnlyCalls.map((tc) => executeSingleTool(tc, opts, stepNumber, steps, toolsUsedSet)),
    );
    for (const msg of readOnlyResults) {
      messages.push(msg);
    }

    // Execute write tools sequentially
    for (const tc of writeCalls) {
      const msg = await executeSingleTool(tc, opts, stepNumber, steps, toolsUsedSet);
      messages.push(msg);
    }
  }

  // ── maxSteps exceeded ──
  const stepsWithContent = steps.filter((s): s is AgentStep & { content: string } => !!s.content);
  const lastContent = stepsWithContent.length > 0 ? stepsWithContent[stepsWithContent.length - 1].content : "";
  return {
    content: lastContent
      ? `${lastContent}\n\n[WARNING: Agent loop reached max steps (${maxSteps})]`
      : `[WARNING: Agent loop reached max steps (${maxSteps}) without producing a final response]`,
    steps,
    totalTokens,
    toolsUsed: [...toolsUsedSet],
  };
}

// ─── Single Tool Execution Helper ───

async function executeSingleTool(
  tc: ToolCall,
  opts: AgentLoopOptions,
  parentStep: number,
  steps: AgentStep[],
  toolsUsedSet: Set<string>,
): Promise<ChatMessage> {
  const toolName = tc.function.name;
  const tool = opts.tools.get(toolName);

  let input: unknown;
  try {
    input = JSON.parse(tc.function.arguments);
  } catch {
    input = tc.function.arguments;
  }

  const toolStart = Date.now();
  let output: unknown;
  let errorMsg: string | undefined;

  if (!tool) {
    errorMsg = `Tool "${toolName}" not found in registry`;
  } else {
    try {
      // Validate input against schema
      const parsed = tool.inputSchema.parse(input);
      output = await executeToolWithTimeout(tool, parsed, opts.toolContext);
      toolsUsedSet.add(toolName);
    } catch (e: unknown) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }
  }

  const toolDuration = Date.now() - toolStart;

  const toolStep: AgentStep = {
    stepNumber: parentStep,
    type: "tool_exec",
    toolName,
    toolInput: input,
    toolOutput: errorMsg ? { error: errorMsg } : output,
    durationMs: toolDuration,
  };
  steps.push(toolStep);
  opts.onStep?.(toolStep);

  const resultContent = errorMsg
    ? JSON.stringify({ error: errorMsg })
    : JSON.stringify(output);

  return {
    role: "tool",
    tool_call_id: tc.id,
    content: resultContent,
  };
}
