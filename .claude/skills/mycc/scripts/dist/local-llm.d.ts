/**
 * 本地 LLM 调用封装（MLX OmniCoder-9B-4bit）
 *
 * OpenAI 兼容 API，端口 8899
 * 用途：飞书消息意图分类（零成本替代关键词匹配）
 */
/**
 * 检查本地模型服务是否可用
 */
export declare function isLocalLLMAvailable(): Promise<boolean>;
/**
 * 调用本地模型进行消息意图分类
 *
 * @returns "cc" | "codex" | "gemini" | "pipeline" | null（null 表示调用失败，需 fallback）
 */
export declare function classifyIntentLocal(message: string): Promise<"cc" | "codex" | "gemini" | "pipeline" | null>;
//# sourceMappingURL=local-llm.d.ts.map