/**
 * weekly-vision-review.ts — 每周视觉系统深度复盘
 *
 * 分析过去 7 天的视觉质量分数，评估 prompt 微调效果，生成复盘报告。
 * 如有需要，自动调整 prompt 配置（比日评分更大幅度）。
 *
 * 用法: npx tsx scripts/weekly-vision-review.ts
 * 由 scheduler 每周日 05:00 调用。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";

// ─── 类型定义 ───

interface QualityScore {
  date: string;
  promptVersion: number;
  totalEntries: number;
  keywordCoverage: number;
  infoDensity: number;
  presenceConsistency: number;
  changeDetectionAccuracy: number;
  overallScore: number;
}

interface PromptChange {
  date: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
  changes: Record<string, unknown>;
}

interface PromptConfig {
  version: number;
  updatedAt: string;
  templates: {
    present_true: string;
    present_false: string;
    present_unknown: string;
  };
  emphasis: {
    objects: string;
    actions: string;
    environment: string;
  };
}

interface VersionPerformance {
  version: number;
  avgScore: number;
  daysUsed: number;
}

interface WeeklyReview {
  weekEnding: string;
  daysAnalyzed: number;
  avgOverallScore: number;
  scoreTrend: "improving" | "declining" | "stable";
  dimensionAvgs: {
    keywordCoverage: number;
    infoDensity: number;
    presenceConsistency: number;
    changeDetectionAccuracy: number;
  };
  weakestDimension: string;
  strongestDimension: string;
  promptVersionsUsed: number[];
  promptChanges: number;
  versionPerformance: VersionPerformance[];
  recommendation: string;
  adjustments: {
    objects: string;
    actions: string;
    environment: string;
  } | null;
}

// ─── 常量 ───

const TREND_THRESHOLD = 0.03;
const VERSION_REGRESSION_THRESHOLD = 0.05;
const WEAK_DIMENSION_THRESHOLD = 0.3;
const MAX_WEEKLY_REVIEWS = 52;

const DIMENSION_KEYS = [
  "keywordCoverage",
  "infoDensity",
  "presenceConsistency",
  "changeDetectionAccuracy",
] as const;

type DimensionKey = (typeof DIMENSION_KEYS)[number];

const DIMENSION_LABELS: Record<DimensionKey, string> = {
  keywordCoverage: "关键词覆盖率",
  infoDensity: "信息密度",
  presenceConsistency: "在位一致性",
  changeDetectionAccuracy: "变化检测准确率",
};

const DIMENSION_EMPHASIS_MAP: Record<DimensionKey, keyof PromptConfig["emphasis"]> = {
  keywordCoverage: "objects",
  infoDensity: "actions",
  presenceConsistency: "environment",
  changeDetectionAccuracy: "actions",
};

// ─── 工具函数 ───

function readJsonlFile<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return null;
  return JSON.parse(content) as T;
}

function round(value: number, decimals: number = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getSundayDate(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sunday
  const diff = day === 0 ? 0 : 7 - day;
  const sunday = new Date(now.getTime() + diff * 86400_000);
  return sunday.toISOString().slice(0, 10);
}

function getDateNDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}

// ─── 趋势判断（前半/后半均值对比） ───

function computeTrend(scores: number[]): "improving" | "declining" | "stable" {
  if (scores.length < 2) return "stable";
  const mid = Math.ceil(scores.length / 2);
  const firstHalf = scores.slice(0, mid);
  const secondHalf = scores.slice(mid);
  const avgFirst = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
  const delta = avgSecond - avgFirst;
  if (delta > TREND_THRESHOLD) return "improving";
  if (delta < -TREND_THRESHOLD) return "declining";
  return "stable";
}

// ─── 版本性能分组 ───

function computeVersionPerformance(scores: readonly QualityScore[]): VersionPerformance[] {
  const groups = new Map<number, number[]>();
  for (const s of scores) {
    const arr = groups.get(s.promptVersion) ?? [];
    arr.push(s.overallScore);
    groups.set(s.promptVersion, arr);
  }
  return [...groups.entries()]
    .map(([version, vals]) => ({
      version,
      avgScore: round(vals.reduce((a, b) => a + b, 0) / vals.length),
      daysUsed: vals.length,
    }))
    .sort((a, b) => a.version - b.version);
}

// ─── 维度分析 ───

function computeDimensionAvgs(scores: readonly QualityScore[]): Record<DimensionKey, number> {
  const sums: Record<DimensionKey, number> = {
    keywordCoverage: 0,
    infoDensity: 0,
    presenceConsistency: 0,
    changeDetectionAccuracy: 0,
  };
  for (const s of scores) {
    for (const key of DIMENSION_KEYS) {
      sums[key] += s[key];
    }
  }
  const n = scores.length;
  return {
    keywordCoverage: round(sums.keywordCoverage / n),
    infoDensity: round(sums.infoDensity / n),
    presenceConsistency: round(sums.presenceConsistency / n),
    changeDetectionAccuracy: round(sums.changeDetectionAccuracy / n),
  };
}

function findWeakestAndStrongest(avgs: Record<DimensionKey, number>): {
  weakest: DimensionKey;
  strongest: DimensionKey;
} {
  let weakest: DimensionKey = DIMENSION_KEYS[0];
  let strongest: DimensionKey = DIMENSION_KEYS[0];
  for (const key of DIMENSION_KEYS) {
    if (avgs[key] < avgs[weakest]) weakest = key;
    if (avgs[key] > avgs[strongest]) strongest = key;
  }
  return { weakest, strongest };
}

// ─── 生成建议文本 ───

function generateRecommendation(
  trend: "improving" | "declining" | "stable",
  avgScore: number,
  weakest: DimensionKey,
  weakestAvg: number,
  versionPerf: readonly VersionPerformance[],
  rolledBack: boolean,
): string {
  const trendLabel = trend === "improving" ? "上升" : trend === "declining" ? "下滑" : "稳定";
  const weakLabel = DIMENSION_LABELS[weakest];

  if (rolledBack) {
    const best = versionPerf.reduce((a, b) => (a.avgScore > b.avgScore ? a : b));
    return `本周质量${trendLabel}（均分${avgScore}），当前版本表现不如 v${best.version}，已自动回滚。`;
  }

  if (trend === "improving") {
    return `本周整体质量${trendLabel}（均分${avgScore}），方向正确，保持当前 prompt 配置。`;
  }

  if (weakestAvg < WEAK_DIMENSION_THRESHOLD) {
    return `本周整体质量${trendLabel}（均分${avgScore}），${weakLabel}偏低（${weakestAvg}），建议持续强化相关描述。`;
  }

  return `本周整体质量${trendLabel}（均分${avgScore}），各维度均衡，继续观察。`;
}

// ─── Prompt 深度调整 ───

function generateEmphasisText(dimension: DimensionKey): string {
  const emphasisTemplates: Record<DimensionKey, string> = {
    keywordCoverage: "务必列出桌面上所有可见物品（显示器、键盘、鼠标、水杯、手机等），不要遗漏。",
    infoDensity: "描述应包含具体动作细节（如打字、阅读、喝水），而非笼统的'在工作'。",
    presenceConsistency: "明确判断画面中是否有人在位，如果有，指出具体位置和姿态。",
    changeDetectionAccuracy: "仔细对比上一帧，指出任何物品位移、人员进出或环境变化。",
  };
  return emphasisTemplates[dimension];
}

interface AdjustmentResult {
  adjustments: WeeklyReview["adjustments"];
  shouldRollback: boolean;
  rollbackVersion: number | null;
  newEmphasis: PromptConfig["emphasis"] | null;
}

function decideAdjustments(
  trend: "improving" | "declining" | "stable",
  weakest: DimensionKey,
  weakestAvg: number,
  versionPerf: readonly VersionPerformance[],
  currentConfig: PromptConfig | null,
): AdjustmentResult {
  // improving → 保持，不调整
  if (trend === "improving") {
    return { adjustments: null, shouldRollback: false, rollbackVersion: null, newEmphasis: null };
  }

  // declining 且当前版本表现差 → 回滚到表现最好的版本
  if (trend === "declining" && versionPerf.length >= 2) {
    const current = versionPerf[versionPerf.length - 1];
    const best = versionPerf.reduce((a, b) => (a.avgScore > b.avgScore ? a : b));
    if (current.avgScore < best.avgScore - VERSION_REGRESSION_THRESHOLD) {
      return {
        adjustments: null,
        shouldRollback: true,
        rollbackVersion: best.version,
        newEmphasis: null,
      };
    }
  }

  // stable 且最弱维度 < 0.3 → 针对性强化
  if (weakestAvg < WEAK_DIMENSION_THRESHOLD) {
    const emphasisKey = DIMENSION_EMPHASIS_MAP[weakest];
    const emphasisText = generateEmphasisText(weakest);
    const currentEmphasis = currentConfig?.emphasis ?? { objects: "", actions: "", environment: "" };
    const newEmphasis: PromptConfig["emphasis"] = {
      ...currentEmphasis,
      [emphasisKey]: emphasisText,
    };
    return {
      adjustments: {
        objects: newEmphasis.objects,
        actions: newEmphasis.actions,
        environment: newEmphasis.environment,
      },
      shouldRollback: false,
      rollbackVersion: null,
      newEmphasis,
    };
  }

  return { adjustments: null, shouldRollback: false, rollbackVersion: null, newEmphasis: null };
}

// ─── 应用 prompt 调整 ───

function applyPromptAdjustment(
  configPath: string,
  historyPath: string,
  currentConfig: PromptConfig,
  adjustment: AdjustmentResult,
  weekEnding: string,
): { newVersion: number } {
  const today = new Date().toISOString().slice(0, 10);
  const oldVersion = currentConfig.version;
  const newVersion = oldVersion + 1;

  if (adjustment.shouldRollback && adjustment.rollbackVersion !== null) {
    // 回滚：清空 emphasis，版本号仍自增
    const updatedConfig: PromptConfig = {
      ...currentConfig,
      version: newVersion,
      updatedAt: today,
      emphasis: { objects: "", actions: "", environment: "" },
    };
    writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n", "utf-8");

    const change: PromptChange = {
      date: today,
      fromVersion: oldVersion,
      toVersion: newVersion,
      reason: `周复盘回滚：当前版本表现差于 v${adjustment.rollbackVersion}`,
      changes: { action: "rollback", targetVersion: adjustment.rollbackVersion },
    };
    appendFileSync(historyPath, JSON.stringify(change) + "\n", "utf-8");

    return { newVersion };
  }

  if (adjustment.newEmphasis !== null) {
    const updatedConfig: PromptConfig = {
      ...currentConfig,
      version: newVersion,
      updatedAt: today,
      emphasis: adjustment.newEmphasis,
    };
    writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n", "utf-8");

    const change: PromptChange = {
      date: today,
      fromVersion: oldVersion,
      toVersion: newVersion,
      reason: `周复盘强化：针对薄弱维度调整 emphasis`,
      changes: { action: "strengthen_emphasis", emphasis: adjustment.newEmphasis },
    };
    appendFileSync(historyPath, JSON.stringify(change) + "\n", "utf-8");

    return { newVersion };
  }

  return { newVersion: oldVersion };
}

// ─── 主入口 ───

function main(): void {
  const brainRoot = resolve(import.meta.dirname, "..");
  const patternsDir = resolve(brainRoot, "data", "patterns");

  // 确保目录存在
  if (!existsSync(patternsDir)) {
    mkdirSync(patternsDir, { recursive: true });
  }

  const scoresPath = resolve(patternsDir, "vision-quality-scores.jsonl");
  const historyPath = resolve(patternsDir, "vision-prompt-history.jsonl");
  const configPath = resolve(patternsDir, "vision-prompt-config.json");
  const reviewsPath = resolve(patternsDir, "vision-weekly-reviews.jsonl");

  // 读取数据
  const allScores = readJsonlFile<QualityScore>(scoresPath);
  const allHistory = readJsonlFile<PromptChange>(historyPath);
  const currentConfig = readJsonFile<PromptConfig>(configPath);

  // 取最近 7 天的评分
  const sevenDaysAgo = getDateNDaysAgo(7);
  const recentScores = allScores.filter((s) => s.date >= sevenDaysAgo);

  // 数据不足检查
  if (recentScores.length < 3) {
    console.log(
      `[weekly-vision-review] 数据不足（${recentScores.length}/3），跳过复盘。`,
    );
    return;
  }

  const weekEnding = getSundayDate();

  // 趋势判断
  const overallScores = recentScores.map((s) => s.overallScore);
  const scoreTrend = computeTrend(overallScores);
  const avgOverallScore = round(overallScores.reduce((a, b) => a + b, 0) / overallScores.length);

  // 版本性能
  const versionPerf = computeVersionPerformance(recentScores);
  const promptVersionsUsed = [...new Set(recentScores.map((s) => s.promptVersion))].sort(
    (a, b) => a - b,
  );

  // 本周 prompt 变更次数
  const promptChangesThisWeek = allHistory.filter((h) => h.date >= sevenDaysAgo).length;

  // 维度分析
  const dimensionAvgs = computeDimensionAvgs(recentScores);
  const { weakest, strongest } = findWeakestAndStrongest(dimensionAvgs);

  // 决定调整
  const adjustment = decideAdjustments(
    scoreTrend,
    weakest,
    dimensionAvgs[weakest],
    versionPerf,
    currentConfig,
  );

  // 应用调整
  let appliedVersion = currentConfig?.version ?? 1;
  const rolledBack = adjustment.shouldRollback;

  if ((adjustment.shouldRollback || adjustment.newEmphasis !== null) && currentConfig !== null) {
    const result = applyPromptAdjustment(
      configPath,
      historyPath,
      currentConfig,
      adjustment,
      weekEnding,
    );
    appliedVersion = result.newVersion;
  }

  // 生成建议
  const recommendation = generateRecommendation(
    scoreTrend,
    avgOverallScore,
    weakest,
    dimensionAvgs[weakest],
    versionPerf,
    rolledBack,
  );

  // 构建复盘报告
  const review: WeeklyReview = {
    weekEnding,
    daysAnalyzed: recentScores.length,
    avgOverallScore,
    scoreTrend,
    dimensionAvgs,
    weakestDimension: weakest,
    strongestDimension: strongest,
    promptVersionsUsed,
    promptChanges: promptChangesThisWeek,
    versionPerformance: versionPerf,
    recommendation,
    adjustments: adjustment.adjustments,
  };

  // 追加到 weekly reviews（滚动保留 52 周）
  appendFileSync(reviewsPath, JSON.stringify(review) + "\n", "utf-8");

  const reviewContent = readFileSync(reviewsPath, "utf-8").trim();
  const reviewLines = reviewContent.split("\n").filter((l) => l.trim());
  if (reviewLines.length > MAX_WEEKLY_REVIEWS) {
    writeFileSync(
      reviewsPath,
      reviewLines.slice(-MAX_WEEKLY_REVIEWS).join("\n") + "\n",
      "utf-8",
    );
  }

  // 输出摘要
  const promptAction =
    appliedVersion !== (currentConfig?.version ?? 1)
      ? `v${currentConfig?.version ?? 1} -> v${appliedVersion} (${rolledBack ? "rollback" : "emphasis " + DIMENSION_EMPHASIS_MAP[weakest]})`
      : "no change";

  console.log(
    [
      `\u2705 Weekly vision review: ${weekEnding}`,
      `   Score: ${avgOverallScore} (${scoreTrend}) | Best: ${strongest} (${dimensionAvgs[strongest]}) | Weak: ${weakest} (${dimensionAvgs[weakest]})`,
      `   Prompt: ${promptAction}`,
      `   Recommendation: ${recommendation}`,
    ].join("\n"),
  );
}

main();
