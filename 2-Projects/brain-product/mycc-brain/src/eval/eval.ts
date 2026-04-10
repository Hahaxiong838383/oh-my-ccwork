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

import { resolve } from "path";
import { DEFAULT_BRAIN_MODEL, DEFAULT_DATA_DIR, DEFAULT_RAW_MODEL } from "../env.js";

// Ensure internal network bypasses proxy
process.env.NO_PROXY = [process.env.NO_PROXY, "10.9.1.155"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

import { ALL_TEST_CASES } from "./test-cases.js";
import { evaluateRetrieval } from "./retrieval-evaluator.js";
import { evaluateGeneration } from "./judge-evaluator.js";
import type { JudgeResult } from "./judge-evaluator.js";
import { generateTsv, saveReport, printSummary, checkRegressions, writeEvalResult } from "./eval-report.js";
import type { EvalResult } from "./eval-report.js";
import { httpGet, httpPost } from "./http-direct.js";
import { loadEvolutionTestCases } from "../services/evolution-test-gen.js";
import { revertAction } from "../services/evolution-engine.js";

// ─── CLI args ───

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const brainUrlArg = args.find((a) => a.startsWith("--brain-url="));
const brainUrl = brainUrlArg
  ? brainUrlArg.split("=")[1]
  : process.env.BRAIN_URL ?? "http://10.9.1.155:19080";

// Gemini Judge: 优先用 Proxy（OpenAI 兼容），fallback 到原生 API
const geminiProxyBase = process.env.GEMINI_PROXY_BASE ?? "http://23.226.135.149:4000/v1";
const geminiProxyKey = process.env.GEMINI_PROXY_KEY ?? "";
const geminiKey = geminiProxyKey || process.env.GEMINI_API_KEY || "";
const judgeModel = "gemini-2.5-flash";
const brainModel = DEFAULT_BRAIN_MODEL;
const rawModel = DEFAULT_RAW_MODEL;

// Admin 认证（eval 需要调用 /admin/api/memory-preview）
const adminUser = process.env.ADMIN_USER ?? "admin";
const adminPass = process.env.ADMIN_PASS ?? "";

// ─── Helpers ───
// Human-readable output → stderr; JSON result → stdout
const log = (...args: unknown[]) => console.error(...args);

// ─── Main ───

async function main() {
  // Track C: 加载动态用例
  const brainRootForTests = resolve(import.meta.dirname, "../..");
  const evolutionTests = loadEvolutionTestCases(brainRootForTests);
  const allCases = ALL_TEST_CASES;  // 动态用例统计单独处理

  log("🧠 mycc-brain 评测系统 v1.2");
  log(`   Brain URL: ${brainUrl}`);
  log(`   Judge: ${judgeModel} (Gemini)`);
  log(`   固定用例: ${ALL_TEST_CASES.length}  动态用例: ${evolutionTests.length}`);
  log(`   模式: ${dryRun ? "dry-run（仅检索层）" : "完整评测"}`);
  log("");

  // 0. Health check (http.request 直连，绕过代理)
  try {
    const { status } = await httpGet(`${brainUrl}/health`);
    if (status !== 200) throw new Error(`${status}`);
    log("✅ Brain 服务正常\n");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Brain 服务不可达: ${brainUrl}/health — ${msg}`);
    console.error("   请确保 brain 在 Studio 上运行中");
    process.exit(1);
  }

  // 0.5 Admin 认证（获取 Bearer token）
  let authHeaders: Record<string, string> | undefined;
  if (adminPass) {
    try {
      const { status, data } = await httpPost(`${brainUrl}/admin/api/login`, {
        username: adminUser,
        password: adminPass,
      });
      const token = (data as { token?: string })?.token;
      if (status === 200 && token) {
        authHeaders = { Authorization: `Bearer ${token}` };
        log("✅ Admin 认证成功\n");
      } else {
        log(`⚠️  Admin 认证失败 (${status})，检索评测可能受影响\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`⚠️  Admin 登录异常: ${msg}\n`);
    }
  } else {
    log("⚠️  ADMIN_PASS 未设置，检索评测可能因 401 失败\n");
  }

  // 1. 检索层评测
  log("━━━ Phase 1: 检索层评测 ━━━");
  const retrievalSummary = await evaluateRetrieval(ALL_TEST_CASES, brainUrl, authHeaders);
  log(`\n检索层完成: 召回率=${retrievalSummary.avg_hit_rate} 精确率=${retrievalSummary.avg_precision}\n`);

  if (dryRun) {
    log("\n[dry-run] 检索层详情:");
    for (const r of retrievalSummary.results) {
      const icon =
        r.expected_categories.length === 0
          ? "⬜"
          : r.category_hit_rate >= 0.7
            ? "✅"
            : "❌";
      log(`  ${icon} ${r.id}: hit=${r.category_hit_rate.toFixed(2)} prec=${r.retrieval_precision.toFixed(2)} items=${r.item_count} ${r.latency_ms}ms`);
      if (r.category_hit_rate < 0.7 && r.expected_categories.length > 0) {
        log(`     期望: [${r.expected_categories.join(", ")}]`);
        log(`     实际: [${r.matched_categories.join(", ")}]`);
      }
    }
    process.exit(0);
  }

  // 2. 生成层评测（需要 Gemini Proxy Key 或原生 Key）
  let skipGeneration = false;
  if (!geminiKey) {
    log("⚠️  GEMINI_PROXY_KEY / GEMINI_API_KEY 均未设置，跳过生成层评测");
    log("   设置: export GEMINI_PROXY_KEY=xxx（推荐）或 export GEMINI_API_KEY=AIza...");
    skipGeneration = true;
  }

  let judgeSummary: { results: JudgeResult[]; avg_scores: Record<string, number>; pass: boolean; failures: string[] } | undefined;
  if (!skipGeneration) {
    const useProxy = !!geminiProxyKey;
    log(`━━━ Phase 2: 生成层评测 (LLM-as-Judge via ${useProxy ? "Proxy" : "Native"}) ━━━`);
    judgeSummary = await evaluateGeneration(
      ALL_TEST_CASES,
      brainUrl,
      geminiKey,
      judgeModel,
      useProxy ? geminiProxyBase : undefined,
    );
  } else {
    log("━━━ Phase 2: 生成层评测（已跳过）━━━");
  }

  // 3. 生成 TSV 报告
  const evalDir = resolve(import.meta.dirname, "../../eval");
  const dataDir = DEFAULT_DATA_DIR;

  const tsv = generateTsv({
    cases: ALL_TEST_CASES,
    retrievalResults: retrievalSummary.results,
    judgeResults: judgeSummary?.results ?? [],
    judgeModel,
    brainModel,
    rawModel,
    dataDir,
  });

  const { path: reportPath, isBaseline, diff, baselineTsv } = saveReport(tsv, evalDir);

  // 4. P4 回归检测（skipGeneration 时只检测检索维度）
  const regressions = baselineTsv ? checkRegressions(baselineTsv, tsv, skipGeneration) : [];
  const needsRollback = regressions.some((r) => r.severity === "critical");

  if (regressions.length > 0) {
    log("\n⚠️  回归检测:");
    for (const r of regressions) {
      const icon = r.severity === "critical" ? "🔴" : "🟡";
      log(`  ${icon} ${r.metric}: ${r.baseline.toFixed(2)} → ${r.current.toFixed(2)} (${r.deltaPct.toFixed(1)}%)`);
    }
    if (needsRollback) {
      log("\n🚨 存在 CRITICAL 回归，尝试自动回滚最近 patch...");
      // Track D: 自动回滚最近 24h 内的 evolution actions
      try {
        const { readFileSync, existsSync } = await import("fs");
        const actionsPath = resolve(brainRootForTests, "data/evolution-actions.jsonl");
        if (existsSync(actionsPath)) {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const lines = readFileSync(actionsPath, "utf-8").split("\n").filter(Boolean);
          let reverted = 0;
          for (const line of lines) {
            try {
              const action = JSON.parse(line);
              if (new Date(action.timestamp) >= cutoff && action.applied && action.relatedPatchIds && !action.revertedAt) {
                const regressedMetrics = regressions.map(r => r.metric).join(", ");
                if (revertAction(brainRootForTests, action.diagnosisCaseId, `auto-rollback: regression in ${regressedMetrics}`)) {
                  reverted++;
                }
              }
            } catch { /* skip */ }
          }
          if (reverted > 0) {
            log(`  ↩️  自动回滚了 ${reverted} 个 patch`);
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  ⚠️  自动回滚失败: ${msg}`);
      }
    }
  }

  // 5. 打印总结（→ stderr）
  if (!skipGeneration && judgeSummary) {
    printSummary(
      retrievalSummary.avg_hit_rate,
      retrievalSummary.avg_precision,
      judgeSummary.avg_scores,
      judgeSummary.pass,
      judgeSummary.failures,
      reportPath,
      diff,
    );
  } else {
    log("\n" + "=".repeat(60));
    log("  mycc-brain 评测报告（仅检索层）");
    log("=".repeat(60));
    log(`\n📊 检索层指标:`);
    const hitIcon = retrievalSummary.avg_hit_rate >= 0.7 ? "✅" : "❌";
    const precIcon = retrievalSummary.avg_precision >= 0.6 ? "✅" : "❌";
    log(`  ${hitIcon} 召回率: ${retrievalSummary.avg_hit_rate.toFixed(3)} (≥0.7)`);
    log(`  ${precIcon} 精确率: ${retrievalSummary.avg_precision.toFixed(3)} (≥0.6)`);
    log(`\n⚠️  生成层评测已跳过（GEMINI KEY 缺失）`);
    if (diff) {
      log("\n📈 与 baseline 对比:");
      log(diff);
    }
    log(`\n📄 报告: ${reportPath}`);
    log("=".repeat(60));
  }

  if (isBaseline) {
    log("\n📌 首次运行，已保存为 baseline");
  }

  // 6. 构建 JSON 结果
  const judgePass = judgeSummary?.pass ?? true; // 跳过时视为通过
  const evalResult: EvalResult = {
    timestamp: new Date().toISOString(),
    pass: judgePass && !needsRollback,
    retrieval: {
      hitRate: retrievalSummary.avg_hit_rate,
      precision: retrievalSummary.avg_precision,
    },
    generation: judgeSummary?.avg_scores ?? {},
    regressions,
    needsRollback,
    reportPath,
    diff,
    ...(skipGeneration ? { generationSkipped: true } : {}),
  };

  // 写文件（Admin UI 用）
  const resultPath = writeEvalResult(evalResult, evalDir);
  log(`\n📋 JSON 结果: ${resultPath}`);

  // stdout 输出纯 JSON（run-eval.sh 直接捕获）
  console.log(JSON.stringify(evalResult));

  // Exit code: 0=pass, 1=fail, 3=regression-rollback
  process.exit(needsRollback ? 3 : judgePass ? 0 : 1);
}

main().catch((err) => {
  console.error("评测异常退出:", err);
  process.exit(2);
});
