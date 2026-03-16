/**
 * Gemini API Adapter — 直接调 Google Gemini API（替代 Gemini CLI）
 *
 * 优势：
 * - 支持多模态（视频/图片/音频 + 文本）
 * - 不依赖 Gemini CLI 安装
 * - 支持长 prompt（无命令行参数长度限制）
 * - 支持 function calling（飞书 MCP 工具桥接）
 *
 * 决策记录：2026-03-12，从 CLI 切换到 API
 * 原因：1. Gemini 多模态能力强 2. 分散 cc 负载
 * 更新：大文件（>20MB）自动走 File API 上传
 * 更新：2026-03-14，增加 function calling 支持（飞书 MCP 工具桥接）
 */

import {
  GoogleGenerativeAI,
  type Part,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResult,
} from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { readFile, writeFile, unlink } from "fs/promises";
import { extname, join } from "path";
import { tmpdir } from "os";
import {
  getGeminiFunctionDeclarations,
  callMcpTool,
} from "./mcp-bridge.js";

const MODEL = "gemini-2.5-flash";
const INLINE_SIZE_LIMIT = 19 * 1024 * 1024; // 19MB, 留 1MB 余量
const MAX_TOOL_ROUNDS = 10; // 最多 10 轮 function calling 来回

interface GeminiApiResult {
  output: string;
  error?: string;
  timedOut?: boolean;
}

/** 内存中的媒体数据（不落盘） */
export interface MediaBuffer {
  data: Buffer;
  mimeType: string;
}

interface GeminiApiOptions {
  timeout?: number; // ms, default 300s
  signal?: AbortSignal;
  filePaths?: string[]; // 本地文件路径（图片/视频/音频）
  mediaBuffers?: MediaBuffer[]; // 内存中的媒体数据（飞书文档下载，不落盘）
  enableTools?: boolean; // 启用 function calling（飞书 MCP 工具）
}

// MIME 类型映射
const MIME_MAP: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
};

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 未设置");
  return key;
}

/**
 * 通过 File API 上传大文件（>20MB），返回 fileData Part。
 * 需要先写临时文件（File API 要求文件路径），上传后立即删除。
 */
async function uploadLargeBuffer(
  data: Buffer,
  mimeType: string,
  displayName: string,
): Promise<Part> {
  const fileManager = new GoogleAIFileManager(getApiKey());

  // File API 要求本地文件路径，写临时文件后上传
  const tmpPath = join(tmpdir(), `gemini-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmpPath, data);
    console.log(`[GeminiAPI] File API 上传: ${displayName} (${(data.length / 1024 / 1024).toFixed(1)}MB)`);

    const uploadResult = await fileManager.uploadFile(tmpPath, {
      mimeType,
      displayName,
    });

    console.log(`[GeminiAPI] File API 上传完成: ${uploadResult.file.uri}`);

    // 等待文件处理完成（视频需要处理时间）
    let file = uploadResult.file;
    let waitCount = 0;
    while (file.state === "PROCESSING" && waitCount < 60) {
      console.log(`[GeminiAPI] 等待文件处理... (${waitCount * 5}s)`);
      await new Promise((r) => setTimeout(r, 5000));
      file = await fileManager.getFile(file.name);
      waitCount++;
    }

    if (file.state === "FAILED") {
      throw new Error(`文件处理失败: ${file.name}`);
    }

    return {
      fileData: {
        mimeType: file.mimeType,
        fileUri: file.uri,
      },
    };
  } finally {
    // 清理临时文件
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * 将本地文件转为 Gemini API 的 Part。
 * 小文件用 inline data，大文件用 File API 上传。
 */
async function fileToPart(filePath: string): Promise<Part> {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_MAP[ext];
  if (!mimeType) {
    throw new Error(`不支持的文件类型: ${ext}（支持: ${Object.keys(MIME_MAP).join(", ")}）`);
  }

  const data = await readFile(filePath);

  if (data.length > INLINE_SIZE_LIMIT) {
    return uploadLargeBuffer(data, mimeType, filePath.split("/").pop() || "file");
  }

  return {
    inlineData: {
      mimeType,
      data: data.toString("base64"),
    },
  };
}

/**
 * 将内存中的媒体数据转为 Gemini API 的 Part。
 * 小数据用 inline data，大数据用 File API 上传。
 */
async function mediaBufferToPart(mb: MediaBuffer, index: number): Promise<Part> {
  if (mb.data.length > INLINE_SIZE_LIMIT) {
    return uploadLargeBuffer(mb.data, mb.mimeType, `media-${index}`);
  }

  return {
    inlineData: {
      mimeType: mb.mimeType,
      data: mb.data.toString("base64"),
    },
  };
}

/**
 * 检查 Gemini 响应中是否有 function call
 */
function extractFunctionCalls(result: GenerateContentResult): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const candidate = result.response.candidates?.[0];
  if (!candidate?.content?.parts) return calls;

  for (const part of candidate.content.parts) {
    if ("functionCall" in part && part.functionCall) {
      calls.push({
        name: part.functionCall.name,
        args: (part.functionCall.args as Record<string, unknown>) || {},
      });
    }
  }
  return calls;
}

/**
 * 提取 Gemini 响应中的文本内容
 */
function extractText(result: GenerateContentResult): string {
  try {
    return result.response.text();
  } catch {
    // 如果响应只有 function call 没有文本，text() 会抛异常
    return "";
  }
}

/**
 * 调用 Gemini API（支持纯文本 + 多模态 + function calling）
 */
export async function runGeminiApi(
  prompt: string,
  opts?: GeminiApiOptions,
): Promise<GeminiApiResult> {
  const timeout = opts?.timeout || 300_000;
  const enableTools = opts?.enableTools ?? false;

  const fileCount = (opts?.filePaths?.length || 0) + (opts?.mediaBuffers?.length || 0);
  console.log(`[GeminiAPI] 调用开始 (model=${MODEL}, timeout=${(timeout / 1000).toFixed(0)}s, files=${fileCount}, tools=${enableTools})`);

  try {
    const genAI = new GoogleGenerativeAI(getApiKey());

    // 构建模型配置（有无 function calling）
    const modelConfig: Record<string, unknown> = { model: MODEL };

    if (enableTools) {
      try {
        const functionDeclarations = await getGeminiFunctionDeclarations();
        if (functionDeclarations.length > 0) {
          modelConfig.tools = [{ functionDeclarations }];
          modelConfig.toolConfig = {
            functionCallingConfig: { mode: "AUTO" },
          };
          console.log(`[GeminiAPI] 已注册 ${functionDeclarations.length} 个工具`);
        }
      } catch (err: any) {
        console.error(`[GeminiAPI] 工具注册失败（降级为纯文本模式）: ${err.message}`);
        // 工具注册失败不影响基本功能，降级为纯文本
      }
    }

    const model = genAI.getGenerativeModel(modelConfig as any);

    // 构建 parts：文本 + 可选文件
    const parts: Part[] = [];

    // 添加本地文件（如有）
    if (opts?.filePaths?.length) {
      for (const fp of opts.filePaths) {
        console.log(`[GeminiAPI] 加载本地文件: ${fp}`);
        const part = await fileToPart(fp);
        parts.push(part);
      }
    }

    // 添加内存中的媒体数据（飞书文档下载，不落盘）
    if (opts?.mediaBuffers?.length) {
      for (let i = 0; i < opts.mediaBuffers.length; i++) {
        const mb = opts.mediaBuffers[i];
        console.log(`[GeminiAPI] 加载内存媒体: ${mb.mimeType}, ${(mb.data.length / 1024 / 1024).toFixed(1)}MB`);
        const part = await mediaBufferToPart(mb, i);
        parts.push(part);
      }
    }

    // 添加文本 prompt
    parts.push({ text: prompt });

    // 带超时的调用
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // 合并外部 signal
    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      // ── 首次调用 ──
      let result = await model.generateContent(parts);
      let functionCalls = extractFunctionCalls(result);

      // ── Function calling 循环 ──
      if (enableTools && functionCalls.length > 0) {
        // 用多轮对话方式处理 function calling
        const history: Content[] = [
          { role: "user", parts },
          { role: "model", parts: result.response.candidates?.[0]?.content?.parts || [] },
        ];

        let round = 0;
        while (functionCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
          round++;
          console.log(`[GeminiAPI] Function calling 第 ${round} 轮，${functionCalls.length} 个调用`);

          // 执行所有 function calls
          const responseParts: Part[] = [];
          for (const fc of functionCalls) {
            console.log(`[GeminiAPI] 执行工具: ${fc.name}`);
            const { result: toolResult } = await callMcpTool(fc.name, fc.args);
            responseParts.push({
              functionResponse: {
                name: fc.name,
                response: typeof toolResult === "object" ? toolResult as object : { result: toolResult },
              },
            } as Part);
          }

          // 将工具结果发回 Gemini
          history.push({ role: "user", parts: responseParts });

          result = await model.generateContent({ contents: history } as any);

          // 追加模型响应到历史
          const modelParts = result.response.candidates?.[0]?.content?.parts || [];
          history.push({ role: "model", parts: modelParts });

          // 检查是否还有 function call
          functionCalls = extractFunctionCalls(result);
        }

        if (round >= MAX_TOOL_ROUNDS && functionCalls.length > 0) {
          console.warn(`[GeminiAPI] Function calling 达到最大轮数 ${MAX_TOOL_ROUNDS}，强制结束`);
        }
      }

      clearTimeout(timer);

      const text = extractText(result);
      console.log(`[GeminiAPI] 完成, output length: ${text.length}`);
      return { output: text };
    } catch (err: any) {
      clearTimeout(timer);

      if (controller.signal.aborted) {
        if (opts?.signal?.aborted) {
          console.log("[GeminiAPI] 已被用户中止");
          return { output: "", error: "USER_ABORTED" };
        }
        console.error("[GeminiAPI] TIMEOUT");
        return { output: "", error: `TIMEOUT after ${timeout / 1000}s`, timedOut: true };
      }

      console.error("[GeminiAPI] 调用失败:", err.message);
      return { output: "", error: err.message };
    }
  } catch (err: any) {
    console.error("[GeminiAPI] 初始化失败:", err.message);
    return { output: "", error: err.message };
  }
}
