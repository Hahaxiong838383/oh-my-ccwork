#!/usr/bin/env npx tsx
/**
 * eval.ts — mycc-brain 自动化评测入口
 *
 * 用法:
 *   npx tsx src/eval/eval.ts                     # 完整评测
 *   npx tsx src/eval/eval.ts --dry-run            # 只跑检索层
 *   npx tsx src/eval/eval.ts --brain-url http://x # 自定义 brain 地址
 *
 * 环境变量:
 *   GEMINI_API_KEY   — Gemini Judge 用
 *   BRAIN_URL        — brain 服务地址（默认 http://10.9.1.155:19080）
 */

import { config } from "dotenv";
import { resolve } from "path";

// Ensure internal network bypasses proxy
process.env.NO_PROXY = [process.env.NO_PROXY, "10.9.1.155"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

// Load .env from project root
config({ path: resolve(import.meta.dirname, "../../.env") });

import { ALL_TEST_CASES } from "./test-cases.js";
import { evaluateRetrieval } from "./retrieval-evaluator.js";
import { evaluateGeneration } from "./judge-evaluator.js";
import { generateTsv, saveReport, printSummary } from "./eval-report.js";
import { httpGet } from "./http-direct.js";

// ─── CLI args ───

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const brainUrlArg = args.find((a) => a.startsWith("--brain-url="));
const brainUrl = brainUrlArg
  ? brainUrlArg.split("=")[1]
  : process.env.BRAIN_URL ?? "http://10.9.1.155:19080";

const geminiKey = process.env.GEMINI_API_KEY ?? "";
const judgeModel = "gemini-2.5-flash";
const brainModel = "cc-qwen";
const rawModel = "raw-qwen";

// ─── Main ───

async function main() {
  console.log("🧠 mycc-brain 评测系统 v1.0");
  console.log(`   Brain URL: ${brainUrl}`);
  console.log(`   Judge: ${judgeModel} (Gemini)`);
  console.log(`   用例数: ${ALL_TEST_CASES.length}`);
  console.log(`   模式: ${dryRun ? "dry-run（仅检索层）" : "完整评测"}`);
  console.log("");

  // 0. Health check (http.request 直连，绕过代理)
  try {
    const { status } = await httpGet(`${brainUrl}/health`);
    if (status !== 200) throw new Error(`${status}`);
    console.log("✅ Brain 服务正常\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Brain 服务不可达: ${brainUrl}/health — ${msg}`);
    console.error("   请确保 brain 在 Studio 上运行中");
    process.exit(1);
  }

  // 1. 检索层评测
  console.log("━━━ Phase 1: 检索层评测 ━━━");
  const retrievalSummary = await evaluateRetrieval(ALL_TEST_CASES, brainUrl);
  console.log(
    `\n检索层完成: 召回率=${retrievalSummary.avg_hit_rate} 精确率=${retrievalSummary.avg_precision}\n`,
  );

  if (dryRun) {
    // Dry-run: just print retrieval results
    console.log("\n[dry-run] 检索层详情:");
    for (const r of retrievalSummary.results) {
      const icon =
        r.expected_categories.length === 0
          ? "⬜"
          : r.category_hit_rate >= 0.7
            ? "✅"
            : "❌";
      console.log(
        `  ${icon} ${r.id}: hit=${r.category_hit_rate.toFixed(2)} prec=${r.retrieval_precision.toFixed(2)} items=${r.item_count} ${r.latency_ms}ms`,
      );
      if (r.category_hit_rate < 0.7 && r.expected_categories.length > 0) {
        console.log(`     期望: [${r.expected_categories.join(", ")}]`);
        console.log(`     实际: [${r.matched_categories.join(", ")}]`);
      }
    }
    process.exit(0);
  }

  // 2. 生成层评测（需要 Gemini Key）
  if (!geminiKey) {
    console.error("❌ GEMINI_API_KEY 未设置，无法运行生成层评测");
    console.error("   设置: export GEMINI_API_KEY=AIza...");
    process.exit(1);
  }

  console.log("━━━ Phase 2: 生成层评测 (LLM-as-Judge) ━━━");
  const judgeSummary = await evaluateGeneration(
    ALL_TEST_CASES,
    brainUrl,
    geminiKey,
    judgeModel,
  );

  // 3. 生成 TSV 报告
  const evalDir = resolve(import.meta.dirname, "../../eval");
  const dataDir = process.env.DATA_DIR ?? resolve(import.meta.dirname, "../../../mycc-data/0-System");

  const tsv = generateTsv({
    cases: ALL_TEST_CASES,
    retrievalResults: retrievalSummary.results,
    judgeResults: judgeSummary.results,
    judgeModel,
    brainModel,
    rawModel,
    dataDir,
  });

  const { path: reportPath, isBaseline, diff } = saveReport(tsv, evalDir);

  // 4. 打印总结
  printSummary(
    retrievalSummary.avg_hit_rate,
    retrievalSummary.avg_precision,
    judgeSummary.avg_scores,
    judgeSummary.pass,
    judgeSummary.failures,
    reportPath,
    diff,
  );

  if (isBaseline) {
    console.log("\n📌 首次运行，已保存为 baseline");
  }

  // Exit code: 0 if pass, 1 if fail
  process.exit(judgeSummary.pass ? 0 : 1);
}

main().catch((err) => {
  console.error("评测异常退出:", err);
  process.exit(2);
});
