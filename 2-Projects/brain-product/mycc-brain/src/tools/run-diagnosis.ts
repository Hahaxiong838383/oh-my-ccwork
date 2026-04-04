/**
 * run-diagnosis.ts — eval 诊断工具
 *
 * 封装 evolution-diagnosis.ts 的 diagnoseLatestEval，
 * 供 Agent Loop 通过 tool calling 获取最近一次 eval 的失败归因报告。
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../services/tool-registry.js";
import { diagnoseLatestEval, type DiagnosisReport } from "../services/evolution-diagnosis.js";

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export const runDiagnosisTool: ToolDefinition<Input, DiagnosisReport | null> = {
  name: "run_diagnosis",
  description:
    "对最近一次 eval 结果进行失败归因诊断，返回每条失败用例的根因分类（keyword_miss / tfidf_threshold / hallucination / prompt_leak）和统计摘要。",
  inputSchema,
  isReadOnly: true,
  isDestructive: false,
  timeoutMs: 10000,

  async execute(_input: Input, ctx: ToolContext): Promise<DiagnosisReport | null> {
    return diagnoseLatestEval(ctx.brainRoot);
  },
};
