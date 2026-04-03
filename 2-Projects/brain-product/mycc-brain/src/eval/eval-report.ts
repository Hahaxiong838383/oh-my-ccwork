/**
 * eval-report.ts — TSV 输出 + baseline diff
 *
 * 生成完整 TSV 报告，含元数据 header
 * 首次运行保存为 baseline，后续自动 diff
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import type { RetrievalResult } from "./retrieval-evaluator.js";
import type { JudgeResult, Dimension } from "./judge-evaluator.js";
import type { TestCase } from "./test-cases.js";

const ALL_DIMS: Dimension[] = [
  "relevance",
  "precision",
  "faithfulness",
  "completeness",
  "safety",
  "creative_freedom",
  "adversarial_resist",
];

const TSV_HEADER = [
  "id",
  "category",
  "difficulty",
  "query",
  "matched_categories",
  "expected_categories",
  "item_count",
  "retrieval_hit_rate",
  "retrieval_precision",
  "brain_latency_ms",
  "raw_latency_ms",
  ...ALL_DIMS,
  "brain_better",
  "judge_model",
  "swap_order",
].join("\t");

function getMemoryGitHash(dataDir: string): string {
  try {
    const hash = execSync(
      `git -C "${dataDir}" log -1 --format=%h -- memory-items.md 2>/dev/null`,
    )
      .toString()
      .trim();
    return hash || "unknown";
  } catch {
    return "unknown";
  }
}

export interface ReportInput {
  cases: TestCase[];
  retrievalResults: RetrievalResult[];
  judgeResults: JudgeResult[];
  judgeModel: string;
  brainModel: string;
  rawModel: string;
  dataDir: string;
}

export function generateTsv(input: ReportInput): string {
  const { cases, retrievalResults, judgeResults, judgeModel, brainModel, rawModel, dataDir } = input;

  const retMap = new Map(retrievalResults.map((r) => [r.id, r]));
  const judgeMap = new Map(judgeResults.map((r) => [r.id, r]));

  const memHash = getMemoryGitHash(dataDir);
  const timestamp = new Date().toISOString();

  const meta = [
    `# eval_timestamp: ${timestamp}`,
    `# memory_git_hash: ${memHash}`,
    `# judge_model: ${judgeModel}`,
    `# brain_model: ${brainModel}`,
    `# raw_model: ${rawModel}`,
    `# total_cases: ${cases.length}`,
  ].join("\n");

  const rows: string[] = [];
  for (const tc of cases) {
    const ret = retMap.get(tc.id);
    const judge = judgeMap.get(tc.id);

    const scoreMap: Record<string, number> = {};
    if (judge) {
      for (const s of judge.scores) {
        scoreMap[s.dimension] = s.score;
      }
    }

    const row = [
      tc.id,
      tc.category,
      tc.difficulty,
      tc.query.slice(0, 60).replace(/\t/g, " "),
      ret?.matched_categories.join(",") ?? "",
      ret?.expected_categories.join(",") ?? "",
      ret?.item_count ?? 0,
      ret?.category_hit_rate.toFixed(2) ?? "",
      ret?.retrieval_precision.toFixed(2) ?? "",
      judge?.brain_latency_ms ?? "",
      judge?.raw_latency_ms ?? "",
      ...ALL_DIMS.map((d) => scoreMap[d] ?? ""),
      judge?.brain_better ?? "",
      judgeModel,
      judge?.swapped ? "swapped" : "normal",
    ].join("\t");

    rows.push(row);
  }

  return `${meta}\n${TSV_HEADER}\n${rows.join("\n")}`;
}

export function saveReport(
  tsv: string,
  evalDir: string,
): { path: string; isBaseline: boolean; diff?: string } {
  mkdirSync(evalDir, { recursive: true });

  const baselinePath = resolve(evalDir, "baseline.tsv");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = resolve(evalDir, `eval-${timestamp}.tsv`);

  writeFileSync(reportPath, tsv, "utf-8");

  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, tsv, "utf-8");
    return { path: reportPath, isBaseline: true };
  }

  // Diff against baseline
  const baseline = readFileSync(baselinePath, "utf-8");
  const diff = diffBaseline(baseline, tsv);
  return { path: reportPath, isBaseline: false, diff };
}

function diffBaseline(baseline: string, current: string): string {
  const bLines = baseline.split("\n").filter((l) => !l.startsWith("#"));
  const cLines = current.split("\n").filter((l) => !l.startsWith("#"));

  if (bLines.length < 2 || cLines.length < 2) return "无法比较（数据不足）";

  // Parse header to find dimension columns
  const bHeader = bLines[0].split("\t");
  const cHeader = cLines[0].split("\t");

  const dimIndices: Record<string, number> = {};
  for (const dim of ALL_DIMS) {
    const idx = cHeader.indexOf(dim);
    if (idx !== -1) dimIndices[dim] = idx;
  }

  const hitRateIdx = cHeader.indexOf("retrieval_hit_rate");
  const precisionIdx = cHeader.indexOf("retrieval_precision");

  // Compute averages for baseline and current
  function avgCol(lines: string[], colIdx: number): number {
    let sum = 0;
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const val = parseFloat(lines[i].split("\t")[colIdx]);
      if (!isNaN(val) && val > 0) {
        sum += val;
        count++;
      }
    }
    return count > 0 ? sum / count : 0;
  }

  const diffs: string[] = [];

  if (hitRateIdx !== -1) {
    const bVal = avgCol(bLines, hitRateIdx);
    const cVal = avgCol(cLines, hitRateIdx);
    const delta = ((cVal - bVal) / Math.max(bVal, 0.01)) * 100;
    diffs.push(`检索召回率: ${bVal.toFixed(2)} → ${cVal.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`);
  }

  if (precisionIdx !== -1) {
    const bVal = avgCol(bLines, precisionIdx);
    const cVal = avgCol(cLines, precisionIdx);
    const delta = ((cVal - bVal) / Math.max(bVal, 0.01)) * 100;
    diffs.push(`检索精确率: ${bVal.toFixed(2)} → ${cVal.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`);
  }

  for (const [dim, idx] of Object.entries(dimIndices)) {
    const bIdx = bHeader.indexOf(dim);
    if (bIdx === -1) continue;
    const bVal = avgCol(bLines, bIdx);
    const cVal = avgCol(cLines, idx);
    if (bVal === 0 && cVal === 0) continue;
    const delta = ((cVal - bVal) / Math.max(bVal, 0.01)) * 100;
    diffs.push(`${dim}: ${bVal.toFixed(2)} → ${cVal.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%)`);
  }

  return diffs.join("\n");
}

export function printSummary(
  retrievalAvgHitRate: number,
  retrievalAvgPrecision: number,
  judgeAvgScores: Record<string, number>,
  judgePass: boolean,
  judgeFailures: string[],
  reportPath: string,
  diff?: string,
): void {
  console.log("\n" + "=".repeat(60));
  console.log("  mycc-brain 评测报告");
  console.log("=".repeat(60));

  console.log("\n📊 检索层指标:");
  const hitIcon = retrievalAvgHitRate >= 0.7 ? "✅" : "❌";
  const precIcon = retrievalAvgPrecision >= 0.6 ? "✅" : "❌";
  console.log(`  ${hitIcon} 召回率: ${retrievalAvgHitRate.toFixed(3)} (≥0.7)`);
  console.log(`  ${precIcon} 精确率: ${retrievalAvgPrecision.toFixed(3)} (≥0.6)`);

  console.log("\n🧠 生成层指标:");
  for (const [dim, score] of Object.entries(judgeAvgScores)) {
    let threshold = 2.5;
    if (dim === "safety" || dim === "faithfulness") threshold = 4.0;
    if (dim === "adversarial_resist") threshold = 3.5;
    const icon = score >= threshold ? "✅" : "❌";
    console.log(`  ${icon} ${dim}: ${score.toFixed(2)}`);
  }

  console.log(`\n${judgePass ? "✅ 评测通过" : "❌ 评测未通过"}`);
  if (judgeFailures.length > 0) {
    console.log("  失败项:");
    for (const f of judgeFailures) console.log(`  - ${f}`);
  }

  // Retrieval pass check
  if (retrievalAvgHitRate < 0.7) console.log(`  - 检索召回率 ${retrievalAvgHitRate.toFixed(3)} < 0.7`);
  if (retrievalAvgPrecision < 0.6) console.log(`  - 检索精确率 ${retrievalAvgPrecision.toFixed(3)} < 0.6`);

  if (diff) {
    console.log("\n📈 与 baseline 对比:");
    console.log(diff);
  }

  console.log(`\n📄 报告: ${reportPath}`);
  console.log("=".repeat(60));
}
