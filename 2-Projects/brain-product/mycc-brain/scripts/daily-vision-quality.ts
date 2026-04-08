/**
 * daily-vision-quality.ts — 每日视觉质量评分 + 轻量 prompt 微调
 *
 * 评估昨天的视觉扫描质量（关键词覆盖、信息密度、在位一致性、变化检测准确度），
 * 输出分数并根据分数自动微调 vision-prompt-config.json 中的 emphasis 字段。
 * 连续 3 天下降时自动回滚到上一个稳定 prompt 版本。
 *
 * 用法: npx tsx scripts/daily-vision-quality.ts
 * 由 scheduler 每日 04:45 调用。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";

// ─── 类型定义 ───

interface SemanticHistoryEntry {
  ts: string;
  present: boolean | null;
  rawText: string;
  method: string;
  change: "person_arrived" | "person_left" | "scene_changed" | null;
}

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

interface PromptConfig {
  version: number;
  updatedAt: string;
  templates: Record<string, string>;
  emphasis: {
    objects: string;
    actions: string;
    environment: string;
  };
}

interface PromptHistoryEntry {
  date: string;
  fromVersion: number;
  toVersion: number;
  reason: string;
  changes: Record<string, string>;
}

// ─── 常量 ───

const OBJECT_KEYWORDS = [
  "显示器", "键盘", "鼠标", "电脑", "手机", "水杯", "咖啡",
  "耳机", "台灯", "笔记本", "iPad", "充电器", "书", "笔",
  "摄像头", "椅", "桌", "音箱",
] as const;

const FILLER_WORDS = [
  "的", "了", "在", "是", "有", "和", "与", "也", "都", "就",
  "被", "把", "着", "吧", "吗", "呢", "啊", "哦", "嗯",
] as const;

const PERSON_WORDS = [
  "川哥", "人", "他", "坐", "站", "走", "工作", "打字", "看", "使用",
] as const;

const KEYWORD_TOTAL = OBJECT_KEYWORDS.length; // 18

const MAX_SCORE_LINES = 90;
const MAX_HISTORY_LINES = 90;

// ─── 评分逻辑 ───

function computeKeywordCoverage(allRawText: string): number {
  const foundKeywords = new Set<string>();
  for (const kw of OBJECT_KEYWORDS) {
    if (allRawText.includes(kw)) {
      foundKeywords.add(kw);
    }
  }
  return foundKeywords.size / KEYWORD_TOTAL;
}

function computeInfoDensity(entries: ReadonlyArray<SemanticHistoryEntry>): number {
  if (entries.length === 0) return 0;

  let totalDensity = 0;
  for (const entry of entries) {
    const text = entry.rawText;
    const chars = [...text]; // 正确处理 Unicode
    const totalChars = chars.length;
    if (totalChars === 0) {
      // 空文本密度为 0
      continue;
    }
    let fillerCount = 0;
    for (const fw of FILLER_WORDS) {
      // 统计每个虚词出现次数
      let idx = 0;
      while (idx < text.length) {
        const pos = text.indexOf(fw, idx);
        if (pos === -1) break;
        fillerCount++;
        idx = pos + fw.length;
      }
    }
    const density = (totalChars - fillerCount) / totalChars;
    totalDensity += Math.max(0, density);
  }

  return totalDensity / entries.length;
}

function computePresenceConsistency(entries: ReadonlyArray<SemanticHistoryEntry>): number {
  if (entries.length === 0) return 0;

  let consistentCount = 0;

  for (const entry of entries) {
    const text = entry.rawText;
    const hasPersonWord = PERSON_WORDS.some((pw) => text.includes(pw));
    // 排除"无人"类否定表述
    const hasNegation = text.includes("无人") || text.includes("没有人") || text.includes("空无");

    if (entry.present === true) {
      // present=true 时应含人物描述词
      if (hasPersonWord) consistentCount++;
    } else if (entry.present === false) {
      // present=false 时不应含人物描述词（排除否定表述）
      if (!hasPersonWord || hasNegation) consistentCount++;
    } else {
      // present=null，无法判断，算一致
      consistentCount++;
    }
  }

  return consistentCount / entries.length;
}

function computeChangeDetectionAccuracy(entries: ReadonlyArray<SemanticHistoryEntry>): number {
  // 找有 change 事件的记录及其前一条
  const changeEntries: Array<{ current: SemanticHistoryEntry; previous: SemanticHistoryEntry }> = [];

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].change !== null && entries[i].change !== undefined) {
      changeEntries.push({ current: entries[i], previous: entries[i - 1] });
    }
  }

  if (changeEntries.length === 0) return 0.5; // 无 change 记录时默认 0.5

  let accurateCount = 0;

  for (const { current, previous } of changeEntries) {
    const diffRate = computeCharDiffRate(previous.rawText, current.rawText);
    // 有 change 但差异率 >= 0.3 → 准确
    if (diffRate >= 0.3) {
      accurateCount++;
    }
  }

  return accurateCount / changeEntries.length;
}

function computeCharDiffRate(textA: string, textB: string): number {
  const setA = new Set([...textA]);
  const setB = new Set([...textB]);

  // 交集
  let intersectionSize = 0;
  for (const ch of setA) {
    if (setB.has(ch)) intersectionSize++;
  }

  // 并集
  const unionSet = new Set([...setA, ...setB]);
  const unionSize = unionSet.size;

  if (unionSize === 0) return 0;

  return 1 - intersectionSize / unionSize;
}

function computeOverallScore(score: Omit<QualityScore, "overallScore">): number {
  return (
    score.keywordCoverage * 0.3 +
    score.infoDensity * 0.3 +
    score.presenceConsistency * 0.25 +
    score.changeDetectionAccuracy * 0.15
  );
}

// ─── Prompt 微调 ───

interface AdjustmentRule {
  threshold: number;
  below: string;
  above: string;
}

const ADJUSTMENTS: Record<string, AdjustmentRule> = {
  objects:     { threshold: 0.35, below: "重点观察并描述桌上的物品。", above: "" },
  actions:     { threshold: 0.6,  below: "注意描述人物的具体动作。",   above: "" },
  environment: { threshold: 0.25, below: "简洁直接，减少重复。",       above: "" },
};

function adjustPromptConfig(
  config: Readonly<PromptConfig>,
  score: Readonly<QualityScore>,
  dateStr: string,
): { updatedConfig: PromptConfig; changed: boolean; changes: Record<string, string>; reason: string } {
  const changes: Record<string, string> = {};
  const reasons: string[] = [];

  // keywordCoverage -> objects
  const newObjects = score.keywordCoverage < ADJUSTMENTS.objects.threshold
    ? ADJUSTMENTS.objects.below
    : ADJUSTMENTS.objects.above;
  if (newObjects !== config.emphasis.objects) {
    changes.objects = newObjects;
    reasons.push(`keywordCoverage=${score.keywordCoverage.toFixed(2)} ${score.keywordCoverage < ADJUSTMENTS.objects.threshold ? "<" : ">="} ${ADJUSTMENTS.objects.threshold}`);
  }

  // presenceConsistency -> actions
  const newActions = score.presenceConsistency < ADJUSTMENTS.actions.threshold
    ? ADJUSTMENTS.actions.below
    : ADJUSTMENTS.actions.above;
  if (newActions !== config.emphasis.actions) {
    changes.actions = newActions;
    reasons.push(`presenceConsistency=${score.presenceConsistency.toFixed(2)} ${score.presenceConsistency < ADJUSTMENTS.actions.threshold ? "<" : ">="} ${ADJUSTMENTS.actions.threshold}`);
  }

  // infoDensity -> environment
  const newEnvironment = score.infoDensity < ADJUSTMENTS.environment.threshold
    ? ADJUSTMENTS.environment.below
    : ADJUSTMENTS.environment.above;
  if (newEnvironment !== config.emphasis.environment) {
    changes.environment = newEnvironment;
    reasons.push(`infoDensity=${score.infoDensity.toFixed(2)} ${score.infoDensity < ADJUSTMENTS.environment.threshold ? "<" : ">="} ${ADJUSTMENTS.environment.threshold}`);
  }

  const changed = Object.keys(changes).length > 0;

  const updatedConfig: PromptConfig = changed
    ? {
        ...config,
        version: config.version + 1,
        updatedAt: dateStr,
        emphasis: {
          objects: changes.objects ?? config.emphasis.objects,
          actions: changes.actions ?? config.emphasis.actions,
          environment: changes.environment ?? config.emphasis.environment,
        },
      }
    : { ...config };

  return { updatedConfig, changed, changes, reason: reasons.join("; ") };
}

// ─── 安全回滚 ───

function shouldRollback(scoresPath: string): boolean {
  if (!existsSync(scoresPath)) return false;

  const lines = readFileSync(scoresPath, "utf-8").trim().split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;

  const recent = lines.slice(-3).map((l) => JSON.parse(l) as QualityScore);

  // 连续 3 天下降
  const isDecreasing = recent[0].overallScore > recent[1].overallScore
    && recent[1].overallScore > recent[2].overallScore;

  return isDecreasing;
}

function findPreviousPromptVersion(historyPath: string): PromptHistoryEntry | null {
  if (!existsSync(historyPath)) return null;

  const lines = readFileSync(historyPath, "utf-8").trim().split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  // 返回最后一条历史记录
  return JSON.parse(lines[lines.length - 1]) as PromptHistoryEntry;
}

function rollbackPromptConfig(
  config: Readonly<PromptConfig>,
  historyPath: string,
  dateStr: string,
): { rolledBack: boolean; updatedConfig: PromptConfig } {
  const lastChange = findPreviousPromptVersion(historyPath);
  if (lastChange === null) {
    return { rolledBack: false, updatedConfig: { ...config } };
  }

  // 回滚：把变更过的 emphasis 字段还原
  // 逻辑：如果上次变更设置了某个 emphasis，回滚就清空它；如果上次变更清空了，就恢复默认
  const rolledBackEmphasis = { ...config.emphasis };

  for (const [key, value] of Object.entries(lastChange.changes)) {
    if (key in rolledBackEmphasis) {
      // 反转变更：如果上次设了非空值，回滚清空；如果上次清空了，恢复对应的 below 值
      const rule = ADJUSTMENTS[key];
      if (rule) {
        rolledBackEmphasis[key as keyof typeof rolledBackEmphasis] = value === "" ? rule.below : "";
      }
    }
  }

  const updatedConfig: PromptConfig = {
    ...config,
    version: config.version + 1,
    updatedAt: dateStr,
    emphasis: rolledBackEmphasis,
  };

  return { rolledBack: true, updatedConfig };
}

// ─── JSONL 工具函数 ───

function truncateJsonl(filePath: string, maxLines: number): void {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf-8").trim();
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length > maxLines) {
    writeFileSync(filePath, lines.slice(-maxLines).join("\n") + "\n", "utf-8");
  }
}

function readJsonlSafe<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];

  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

// ─── 主入口 ───

function main(): void {
  const brainRoot = resolve(import.meta.dirname, "..");

  // 计算昨天日期
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  const dateStr = yesterday.toISOString().slice(0, 10);

  // 读取昨天的 semantic-history
  const historyPath = resolve(brainRoot, "data", "activity", `semantic-history-${dateStr}.jsonl`);
  if (!existsSync(historyPath)) {
    console.log(`[vision-quality] 无昨日数据，跳过`);
    return;
  }

  const content = readFileSync(historyPath, "utf-8").trim();
  if (!content) {
    console.log(`[vision-quality] 无昨日数据，跳过`);
    return;
  }

  const entries: SemanticHistoryEntry[] = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SemanticHistoryEntry);

  if (entries.length === 0) {
    console.log(`[vision-quality] 无昨日数据，跳过`);
    return;
  }

  // 按时间排序
  const sorted = [...entries].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
  );

  // 确保输出目录存在
  const patternsDir = resolve(brainRoot, "data", "patterns");
  if (!existsSync(patternsDir)) {
    mkdirSync(patternsDir, { recursive: true });
  }

  // 读取当前 prompt config
  const configPath = resolve(patternsDir, "vision-prompt-config.json");
  const config: PromptConfig = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8")) as PromptConfig
    : {
        version: 1,
        updatedAt: dateStr,
        templates: {},
        emphasis: { objects: "", actions: "", environment: "" },
      };

  // ─── 计算各维度分数 ───

  const allRawText = sorted.map((e) => e.rawText).join("\n");
  const keywordCoverage = computeKeywordCoverage(allRawText);
  const infoDensity = computeInfoDensity(sorted);
  const presenceConsistency = computePresenceConsistency(sorted);
  const changeDetectionAccuracy = computeChangeDetectionAccuracy(sorted);

  const partialScore = {
    date: dateStr,
    promptVersion: config.version,
    totalEntries: sorted.length,
    keywordCoverage,
    infoDensity,
    presenceConsistency,
    changeDetectionAccuracy,
  };

  const overallScore = computeOverallScore(partialScore);

  const score: QualityScore = { ...partialScore, overallScore };

  // ─── 追加评分 ───

  const scoresPath = resolve(patternsDir, "vision-quality-scores.jsonl");
  appendFileSync(scoresPath, JSON.stringify(score) + "\n", "utf-8");
  truncateJsonl(scoresPath, MAX_SCORE_LINES);

  // ─── 安全回滚检查 ───

  const historyFilePath = resolve(patternsDir, "vision-prompt-history.jsonl");

  if (shouldRollback(scoresPath)) {
    const { rolledBack, updatedConfig } = rollbackPromptConfig(config, historyFilePath, dateStr);
    if (rolledBack) {
      writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n", "utf-8");

      const rollbackEntry: PromptHistoryEntry = {
        date: dateStr,
        fromVersion: config.version,
        toVersion: updatedConfig.version,
        reason: "连续3天overallScore下降，自动回滚",
        changes: { ...updatedConfig.emphasis },
      };
      appendFileSync(historyFilePath, JSON.stringify(rollbackEntry) + "\n", "utf-8");
      truncateJsonl(historyFilePath, MAX_HISTORY_LINES);

      console.log(`⚠️ Vision quality rollback: ${dateStr} score=${overallScore.toFixed(3)} → prompt rolled back to v${updatedConfig.version}`);
      return;
    }
  }

  // ─── Prompt 微调 ───

  const { updatedConfig, changed, changes, reason } = adjustPromptConfig(config, score, dateStr);

  if (changed) {
    writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2) + "\n", "utf-8");

    const historyEntry: PromptHistoryEntry = {
      date: dateStr,
      fromVersion: config.version,
      toVersion: updatedConfig.version,
      reason,
      changes,
    };
    appendFileSync(historyFilePath, JSON.stringify(historyEntry) + "\n", "utf-8");
    truncateJsonl(historyFilePath, MAX_HISTORY_LINES);
  }

  const version = changed ? updatedConfig.version : config.version;
  console.log(`✅ Vision quality: ${dateStr} score=${overallScore.toFixed(3)} version=${version}`);
}

main();
