/**
 * tool-registry.ts — 工具注册中心
 *
 * Agent Loop 的工具管理层：注册、查询、生成 OpenAI function calling 格式。
 * zodToJsonSchema 自行实现，支持 z.object/string/number/boolean/enum/optional/array。
 */

import { z } from "zod";

// ─── Types ───

export interface ToolContext {
  brainRoot: string;
  dataDir: string;
  conversationId?: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  /** MCP 工具可提供原始 JSON Schema，跳过 zodToJsonSchema 转换 */
  rawJsonSchema?: Record<string, unknown>;
  isReadOnly: boolean;
  isDestructive: boolean;
  timeoutMs: number;
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}

// ─── Safety Constants ───

export const MAX_AGENT_STEPS = 10;
export const MAX_TOTAL_TOKENS = 50_000;
export const DEFAULT_ALLOWED_TOOLS = [
  "search_memory",
  "list_memories",
  "run_diagnosis",
];

// ─── Zod → JSON Schema (simple impl for zod v4) ───

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  description?: string;
}

function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const def = (schema as any)._zod?.def;
  if (!def) return {};

  switch (def.type) {
    case "string":
      return { type: "string" };

    case "number":
      return { type: "number" };

    case "boolean":
      return { type: "boolean" };

    case "enum": {
      const values = Object.values(def.entries) as string[];
      return { type: "string", enum: values };
    }

    case "optional": {
      const inner = def.innerType as z.ZodType | undefined;
      if (!inner) return {};
      return zodToJsonSchema(inner);
    }

    case "array": {
      const element = def.element as z.ZodType | undefined;
      return {
        type: "array",
        items: element ? zodToJsonSchema(element) : {},
      };
    }

    case "object": {
      const shape = (schema as any)._zod?.def?.shape as
        | Record<string, z.ZodType>
        | undefined;
      if (!shape) return { type: "object", properties: {} };

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const fieldDef = (fieldSchema as any)._zod?.def;
        properties[key] = zodToJsonSchema(fieldSchema as z.ZodType);
        if (fieldDef?.type !== "optional") {
          required.push(key);
        }
      }

      const result: JsonSchema = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }

    default:
      return {};
  }
}

// ─── OpenAI Function Calling Format ───

interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

// ─── Registry ───

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: ToolDefinition<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  toOpenAITools(): OpenAIFunctionTool[] {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        // MCP 工具提供原始 JSON Schema，内置工具走 zodToJsonSchema
        parameters: tool.rawJsonSchema ?? zodToJsonSchema(tool.inputSchema),
      },
    }));
  }
}
