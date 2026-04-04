/**
 * brain 记忆摄入对齐 eval
 * 用法：npx tsx tests/memory-spec/intake-alignment.ts
 *
 * 验证维度：
 * - 命名空间一致率（brain 提取的 namespace ∈ 预期集合）
 * - 维度一致率（dimension 匹配）
 * - 事实覆盖率（预期 mustContain 关键词在 content 中出现）
 * - 空对话拒绝率（无可提取时返回空数组 + skipReason）
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// 直接导入 intake 的内部解析函数来测试
// 注意：这里不实际调 LLM，而是如果想跑真实 LLM 测试，需要传入真实 route

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

// 主函数：加载用例，输出评分模板
async function main() {
  const casesPath = resolve(import.meta.dirname!, "intake-cases.json");
  const cases: TestCase[] = JSON.parse(readFileSync(casesPath, "utf-8"));

  console.log(`\n🧪 Brain 记忆摄入对齐 Eval`);
  console.log(`   用例数: ${cases.length}`);
  console.log(`   模式: dry-run（输出用例结构，不调 LLM）\n`);

  // dry-run 模式：输出用例结构供人工 review
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
    `\n💡 跑真实 eval: 传入 --live 参数（需要 Ollama 或 API 可用）`,
  );

  // 导出 evaluateCase 供外部使用
  return { cases, evaluateCase };
}

main().catch(console.error);

export { evaluateCase };
export type { TestCase, ScoreResult };
