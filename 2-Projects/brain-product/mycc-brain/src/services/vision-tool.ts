/**
 * vision-tool.ts — look_at MCP 工具
 *
 * 用摄像头回答视觉问题：读取最新帧 + 调用 Ollama minicpm-v。
 */

import { z } from "zod";
import { join } from "path";
import { existsSync, statSync } from "fs";
import { askOllamaVision } from "./ollama-vision.js";
import type { ToolDefinition, ToolContext } from "./tool-registry.js";

const lookAtInputSchema = z.object({
  question: z
    .string()
    .describe("要问的视觉问题，例如：桌上有什么、他穿什么衣服"),
});

type LookAtInput = z.infer<typeof lookAtInputSchema>;

interface LookAtOutput {
  answer?: string;
  imageAge?: number;
  model?: string;
  error?: string;
}

export const lookAtTool: ToolDefinition<LookAtInput, LookAtOutput> = {
  name: "look_at",
  description:
    "用摄像头回答视觉问题。输入一个关于当前环境的问题，返回基于实时画面的回答。适用于询问环境中的物品、人物外观、场景状态等。",
  inputSchema: lookAtInputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 60_000,

  execute: async (
    input: LookAtInput,
    ctx: ToolContext,
  ): Promise<LookAtOutput> => {
    const imagePath = join(ctx.dataDir, "activity", "latest.jpg");

    if (!existsSync(imagePath)) {
      return { error: "摄像头画面不可用（latest.jpg 不存在）" };
    }

    const imageAge = (Date.now() - statSync(imagePath).mtimeMs) / 1000;
    if (imageAge > 120) {
      return {
        error: `摄像头画面过期（${Math.round(imageAge)}秒前的图片）`,
      };
    }

    try {
      const answer = await askOllamaVision(imagePath, input.question);
      return {
        answer,
        imageAge: Math.round(imageAge),
        model: "minicpm-v",
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `视觉模型调用失败: ${msg}` };
    }
  },
};
