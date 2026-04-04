/**
 * brain 记忆摄入对齐 eval
 * 用法：
 *   npx tsx tests/memory-spec/intake-alignment.ts           # dry-run（输出用例结构）
 *   QWEN_API_KEY=sk-xxx npx tsx tests/memory-spec/intake-alignment.ts --live  # 实际调 LLM
 *
 * 验证维度：
 * - 命名空间一致率（brain 提取的 namespace ∈ 预期集合）
 * - 维度一致率（dimension 匹配）
 * - 事实覆盖率（预期 mustContain 关键词在 content 中出现）
 * - 空对话拒绝率（无可提取时返回空数组 + skipReason）
 */

import { readFileSync, mkdirSync } from "fs";
import { resolve } from "path";

interface TestCase {
  name: string;
  conversation: { user: string; assistant: string };
  expected: {
    factCount: number;
    namespaces: string[];
    dimensions: string[];
    mustContain: string[];
    mustNotContain: string[];
    mustHaveSkipReason?: boolean;
  };
}

interface ScoreResult {
  name: string;
  namespaceMatch: boolean;
  dimensionMatch: boolean;
  coverageScore: number; // 0-1，mustContain 命中率
  factCountMatch: boolean;
  skipReasonCorrect: boolean;
  passed: boolean;
}

function evaluateCase(
  testCase: TestCase,
  facts: ReadonlyArray<{
    readonly namespace: string;
    readonly content: string;
    readonly dimension: string;
  }>,
  skipReason: string | null,
): ScoreResult {
  const e = testCase.expected;

  // 命名空间一致
  const extractedNs = facts.map((f) => f.namespace);
  const namespaceMatch =
    e.namespaces.length === 0
      ? extractedNs.length === 0
      : e.namespaces.every((ns) =>
          extractedNs.some((en) => en.includes(ns) || ns.includes(en)),
        );

  // 维度一致
  const extractedDims = facts.map((f) => f.dimension);
  const dimensionMatch =
    e.dimensions.length === 0
      ? extractedDims.length === 0
      : e.dimensions.every((d) => extractedDims.includes(d));

  // 事实覆盖率
  const allContent = facts.map((f) => f.content).join(" ");
  const hits = e.mustContain.filter((kw) => allContent.includes(kw));
  const coverageScore =
    e.mustContain.length === 0 ? 1.0 : hits.length / e.mustContain.length;

  // 数量匹配（允许 ±1）
  const factCountMatch = Math.abs(facts.length - e.factCount) <= 1;

  // 空对话拒绝
  const skipReasonCorrect = e.mustHaveSkipReason
    ? facts.length === 0 && skipReason !== null
    : true;

  const passed =
    namespaceMatch &&
    dimensionMatch &&
    coverageScore >= 0.7 &&
    factCountMatch &&
    skipReasonCorrect;

  return {
    name: testCase.name,
    namespaceMatch,
    dimensionMatch,
    coverageScore,
    factCountMatch,
    skipReasonCorrect,
    passed,
  };
}

function runDryMode(cases: readonly TestCase[]): void {
  console.log(`\n🧪 Brain 记忆摄入对齐 Eval`);
  console.log(`   用例数: ${cases.length}`);
  console.log(`   模式: dry-run（输出用例结构，不调 LLM）\n`);

  for (const c of cases) {
    console.log(`📋 ${c.name}`);
    console.log(`   user: ${c.conversation.user.slice(0, 60)}...`);
    console.log(`   期望: ${c.expected.factCount} 条事实`);
    console.log(
      `   命名空间: ${c.expected.namespaces.join(", ") || "(空)"}`,
    );
    console.log(`   维度: ${c.expected.dimensions.join(", ") || "(空)"}`);
    console.log(
      `   必含关键词: ${c.expected.mustContain.join(", ") || "(无)"}`,
    );
    console.log("");
  }

  console.log(`\n📊 对齐指标定义:`);
  console.log(`   命名空间一致率 ≥ 80%`);
  console.log(`   维度一致率 ≥ 80%`);
  console.log(`   事实覆盖率 ≥ 70%`);
  console.log(`   空对话拒绝率 = 100%`);
  console.log(
    `\n💡 跑真实 eval: QWEN_API_KEY=sk-xxx npx tsx tests/memory-spec/intake-alignment.ts --live`,
  );
}

async function runLiveMode(cases: readonly TestCase[]): Promise<void> {
  const { runMemoryIntake } = await import("../../src/services/memory-intake.js");

  // eval 直接用 DashScope qwen3.5-27b（Air 上没有本地 MLX）
  const qwenKey = process.env.QWEN_API_KEY;
  if (!qwenKey) {
    console.error("❌ QWEN_API_KEY 未设置。用法：QWEN_API_KEY=sk-xxx npx tsx ... --live");
    process.exit(1);
  }

  const intakeRoute = {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.5-27b",
    apiKey: qwenKey,
    maxTokens: 2048,
  };

  const tmpDir = `/tmp/brain-eval-${Date.now()}`;
  mkdirSync(tmpDir, { recursive: true });

  console.log(`\n🧪 Brain 记忆摄入对齐 Eval — LIVE`);
  console.log(`   用例数: ${cases.length}`);
  console.log(`   模型: ${intakeRoute.model}`);
  console.log(`   临时目录: ${tmpDir}\n`);

  const results: ScoreResult[] = [];

  for (const c of cases) {
    const caseDir = resolve(tmpDir, c.name);
    mkdirSync(caseDir, { recursive: true });

    const input = {
      userMessage: c.conversation.user,
      assistantReply: c.conversation.assistant,
      dataDir: caseDir,
    };

    const intakeResult = await runMemoryIntake(input, intakeRoute);

    const facts = intakeResult?.facts ?? [];
    const skipReason = intakeResult?.skipReason ?? null;

    const score = evaluateCase(c, facts, skipReason);
    results.push(score);

    const status = score.passed ? "✅" : "❌";
    console.log(`${status} ${c.name}`);
    console.log(`   facts: ${facts.length} (期望 ${c.expected.factCount})`);
    if (facts.length > 0) {
      for (const f of facts) {
        console.log(`     [${f.namespace}] ${f.dimension} — ${f.content.slice(0, 60)}`);
      }
    }
    console.log(
      `   ns: ${score.namespaceMatch ? "✓" : "✗"}  dim: ${score.dimensionMatch ? "✓" : "✗"}  cover: ${(score.coverageScore * 100).toFixed(0)}%  count: ${score.factCountMatch ? "✓" : "✗"}  skip: ${score.skipReasonCorrect ? "✓" : "✗"}`,
    );
    if (intakeResult) {
      console.log(`   model: ${intakeResult.model}  latency: ${intakeResult.latencyMs}ms`);
    } else {
      console.log(`   ⚠️ intake 返回 null（LLM 调用失败）`);
    }
    console.log("");
  }

  // 汇总报告
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const nsRate = (results.filter((r) => r.namespaceMatch).length / total) * 100;
  const dimRate = (results.filter((r) => r.dimensionMatch).length / total) * 100;
  const avgCoverage = (results.reduce((s, r) => s + r.coverageScore, 0) / total) * 100;
  const skipCases = results.filter((r) =>
    cases.find((c) => c.name === r.name)?.expected.mustHaveSkipReason,
  );
  const skipRate =
    skipCases.length > 0
      ? (skipCases.filter((r) => r.skipReasonCorrect).length / skipCases.length) * 100
      : 100;

  console.log("=".repeat(50));
  console.log(`📊 对齐报告`);
  console.log(`   总通过率: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)`);
  console.log(`   命名空间一致率: ${nsRate.toFixed(0)}% ${nsRate >= 80 ? "✅" : "❌"} (≥80%)`);
  console.log(`   维度一致率: ${dimRate.toFixed(0)}% ${dimRate >= 80 ? "✅" : "❌"} (≥80%)`);
  console.log(`   事实覆盖率: ${avgCoverage.toFixed(0)}% ${avgCoverage >= 70 ? "✅" : "❌"} (≥70%)`);
  console.log(`   空对话拒绝率: ${skipRate.toFixed(0)}% ${skipRate === 100 ? "✅" : "❌"} (=100%)`);
  console.log(`\n   临时数据: ${tmpDir}`);
}

async function main(): Promise<void> {
  const isLive = process.argv.includes("--live");
  const casesPath = resolve(import.meta.dirname!, "intake-cases.json");
  const cases: TestCase[] = JSON.parse(readFileSync(casesPath, "utf-8"));

  if (isLive) {
    await runLiveMode(cases);
  } else {
    runDryMode(cases);
  }
}

main().catch(console.error);

export { evaluateCase };
export type { TestCase, ScoreResult };
