/**
 * prediction-engine.ts — GAP3: 内在动机代码实现
 *
 * 五个子模块：
 * 1. Prediction Log: 静默预测用户下一个需求，记录到 JSONL，后续验证命中率
 * 2. Resonance Score: friction 扩展为双向指标（prediction_accuracy × satisfaction × proactive_acceptance）
 * 3. Resolution Ladder: 分辨率阶梯记录（R1→R4），自动升级判定
 * 4. Offline Learning Priority: 巩固任务优先级排序（prediction_failure_impact × learning_feasibility）
 * 5. Resource Request Protocol: cc 向用户请求资源的结构化协议
 *
 * 设计原则：
 * - JSONL 持久化，不依赖数据库
 * - 纯规则 + 统计驱动，不引入额外 LLM 调用
 * - 与 experience-stream、user-state 解耦，通过显式参数传递
 */

import { appendFile, mkdir, readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ═══════════════════════════════════════════════════
// 1. Prediction Log — 静默预测 + 验证
// ═══════════════════════════════════════════════════

export interface PredictionEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly predictedIntent: string;      // 预测的用户下一步意图
  readonly predictedCategory: string;    // 预测的记忆检索类别
  readonly confidence: number;           // [0, 1] 预测置信度
  readonly basis: string;                // 预测依据（简短描述）
  readonly conversationId: string;
  // 验证字段（后续填充）
  readonly actualIntent?: string;
  readonly actualCategory?: string;
  readonly hit?: boolean;                // 预测是否命中
  readonly verifiedAt?: string;
}

function getPredictionDir(brainRoot: string): string {
  return join(brainRoot, "data", "predictions");
}

function todayPredictionFile(brainRoot: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(getPredictionDir(brainRoot), `${d}.jsonl`);
}

let _predictionIdCounter = 0;

function generatePredictionId(): string {
  return `pred_${Date.now()}_${_predictionIdCounter++}`;
}

/**
 * 基于当前用户状态 + 最近查询模式，预测下一步需求。
 * 纯规则驱动，零 LLM 调用。
 */
export function predictNextNeed(
  currentIntent: string,
  currentCategory: string,
  recentCategories: readonly string[],
): { predictedIntent: string; predictedCategory: string; confidence: number; basis: string } {
  // 规则 1：debug 之后通常是 build（修完就接着干）
  if (currentIntent === "debug") {
    return {
      predictedIntent: "build",
      predictedCategory: currentCategory,
      confidence: 0.5,
      basis: "debug→build pattern",
    };
  }

  // 规则 2：learn 之后通常是 build（学完就试）
  if (currentIntent === "learn") {
    return {
      predictedIntent: "build",
      predictedCategory: currentCategory,
      confidence: 0.4,
      basis: "learn→build pattern",
    };
  }

  // 规则 3：manage 之后通常继续 manage（运维连续性）
  if (currentIntent === "manage") {
    return {
      predictedIntent: "manage",
      predictedCategory: currentCategory,
      confidence: 0.4,
      basis: "manage continuity",
    };
  }

  // 规则 4：最近高频类别倾向重复
  if (recentCategories.length >= 3) {
    const freq = new Map<string, number>();
    for (const cat of recentCategories.slice(-5)) {
      freq.set(cat, (freq.get(cat) ?? 0) + 1);
    }
    let topCat = currentCategory;
    let topCount = 0;
    for (const [cat, count] of freq) {
      if (count > topCount) { topCount = count; topCat = cat; }
    }
    if (topCount >= 2) {
      return {
        predictedIntent: currentIntent,
        predictedCategory: topCat,
        confidence: 0.3 + topCount * 0.1,
        basis: `high-freq category: ${topCat} (${topCount}x in last 5)`,
      };
    }
  }

  // 默认：低置信度，保持当前方向
  return {
    predictedIntent: currentIntent,
    predictedCategory: currentCategory,
    confidence: 0.2,
    basis: "default continuation",
  };
}

/** 写入预测记录 */
export async function writePrediction(
  brainRoot: string,
  entry: PredictionEntry,
): Promise<void> {
  try {
    const dir = getPredictionDir(brainRoot);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await appendFile(todayPredictionFile(brainRoot), JSON.stringify(entry) + "\n");
  } catch {
    // fire-and-forget
  }
}

/** 创建并写入一条预测 */
export async function recordPrediction(
  brainRoot: string,
  conversationId: string,
  currentIntent: string,
  currentCategory: string,
  recentCategories: readonly string[],
): Promise<PredictionEntry> {
  const prediction = predictNextNeed(currentIntent, currentCategory, recentCategories);
  const entry: PredictionEntry = {
    id: generatePredictionId(),
    timestamp: new Date().toISOString(),
    conversationId,
    ...prediction,
  };
  await writePrediction(brainRoot, entry);
  return entry;
}

/**
 * 验证同一会话中最近一条未验证的预测。
 * 在每次新请求到来时调用，用当前实际 intent/category 与预测值对比。
 *
 * 验证规则：
 * - intent 完全匹配 → hit=true
 * - intent 不匹配但 category 匹配 → hit=true（宽松匹配）
 * - 都不匹配 → hit=false
 * - 预测时间超过 30 分钟未验证 → 跳过（超时不算）
 *
 * 不修改原 JSONL 行，而是追加一条 verification 记录到同一文件。
 */
export async function verifyLastPrediction(
  brainRoot: string,
  conversationId: string,
  actualIntent: string,
  actualCategory: string,
): Promise<PredictionEntry | null> {
  try {
    const filePath = todayPredictionFile(brainRoot);
    if (!existsSync(filePath)) return null;

    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

    // 从后往前找同一会话中最近一条未验证的预测
    let target: PredictionEntry | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry: PredictionEntry = JSON.parse(lines[i]);
        if (entry.conversationId === conversationId && entry.hit === undefined) {
          target = entry;
          break;
        }
      } catch { /* skip malformed */ }
    }

    if (!target) return null;

    // 超时检查：30 分钟
    const elapsed = Date.now() - new Date(target.timestamp).getTime();
    if (elapsed > 30 * 60 * 1000) return null;

    // 验证规则：intent 匹配或 category 匹配均算 hit
    const hit = target.predictedIntent === actualIntent
      || target.predictedCategory === actualCategory;

    const verification: PredictionEntry = {
      ...target,
      actualIntent,
      actualCategory,
      hit,
      verifiedAt: new Date().toISOString(),
    };

    await appendFile(filePath, JSON.stringify(verification) + "\n");
    return verification;
  } catch {
    // fire-and-forget
    return null;
  }
}

/** 读取最近 N 天的预测记录 */
function readRecentPredictions(brainRoot: string, days: number): PredictionEntry[] {
  const dir = getPredictionDir(brainRoot);
  if (!existsSync(dir)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { readdirSync } = require("fs") as typeof import("fs");
  const files = readdirSync(dir)
    .filter((f: string) => f.endsWith(".jsonl") && f.replace(".jsonl", "") >= cutoffStr)
    .sort();

  const entries: PredictionEntry[] = [];
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return entries;
}

// ═══════════════════════════════════════════════════
// 2. Resonance Score — 共振度指标
// ═══════════════════════════════════════════════════

export interface ResonanceMetrics {
  readonly predictionAccuracy: number;    // [0, 1] 预测命中率
  readonly satisfactionProxy: number;     // [0, 1] 满意度代理（基于 valence 趋势）
  readonly proactiveAcceptance: number;   // [0, 1] 主动建议被接受率（预留，初始 0.5）
  readonly resonanceScore: number;        // 综合共振度 = weighted geometric mean
  readonly sampleSize: number;
}

/**
 * 计算共振度指标（过去 N 天）。
 * resonanceScore = predictionAccuracy^0.4 × satisfactionProxy^0.4 × proactiveAcceptance^0.2
 */
export function computeResonance(
  brainRoot: string,
  days: number = 14,
  recentValences: readonly number[] = [],
): ResonanceMetrics {
  const predictions = readRecentPredictions(brainRoot, days);
  const verified = predictions.filter(p => p.hit !== undefined);

  // 预测准确率
  const hits = verified.filter(p => p.hit === true).length;
  const predictionAccuracy = verified.length > 0 ? hits / verified.length : 0;

  // 满意度代理：近期 valence 均值映射到 [0, 1]
  const avgValence = recentValences.length > 0
    ? recentValences.reduce((s, v) => s + v, 0) / recentValences.length
    : 0;
  const satisfactionProxy = (avgValence + 1) / 2; // [-1,1] → [0,1]

  // 主动建议接受率（R1 阶段无数据，默认 0.5）
  const proactiveAcceptance = 0.5;

  // 加权几何均值
  const resonanceScore = verified.length >= 5
    ? Math.pow(Math.max(predictionAccuracy, 0.01), 0.4) *
      Math.pow(Math.max(satisfactionProxy, 0.01), 0.4) *
      Math.pow(Math.max(proactiveAcceptance, 0.01), 0.2)
    : 0; // 样本不足时不计算

  return {
    predictionAccuracy,
    satisfactionProxy,
    proactiveAcceptance,
    resonanceScore,
    sampleSize: verified.length,
  };
}

// ═══════════════════════════════════════════════════
// 3. Resolution Ladder — 分辨率阶梯
// ═══════════════════════════════════════════════════

export type ResolutionLevel = "R1" | "R2" | "R3" | "R4";

export interface ResolutionState {
  readonly currentLevel: ResolutionLevel;
  readonly accuracy: number;           // 当前级别准确率
  readonly streakWeeks: number;        // 连续达标周数
  readonly targetAccuracy: number;     // 升级阈值（0.7）
  readonly targetWeeks: number;        // 需持续周数（2）
  readonly canUpgrade: boolean;
  readonly updatedAt: string;
}

const RESOLUTION_FILE = "resolution-state.json";

function getResolutionPath(brainRoot: string): string {
  return join(brainRoot, "data", RESOLUTION_FILE);
}

/** 读取当前分辨率状态 */
export function loadResolutionState(brainRoot: string): ResolutionState {
  const p = getResolutionPath(brainRoot);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch { /* fallback */ }
  }

  // 默认 R1
  return {
    currentLevel: "R1",
    accuracy: 0,
    streakWeeks: 0,
    targetAccuracy: 0.7,
    targetWeeks: 2,
    canUpgrade: false,
    updatedAt: new Date().toISOString(),
  };
}

/** 更新分辨率状态（巩固任务调用） */
export async function updateResolutionState(
  brainRoot: string,
  weeklyAccuracy: number,
): Promise<ResolutionState> {
  const prev = loadResolutionState(brainRoot);

  const streakWeeks = weeklyAccuracy >= prev.targetAccuracy
    ? prev.streakWeeks + 1
    : 0;

  const canUpgrade = streakWeeks >= prev.targetWeeks;

  const nextLevel: ResolutionLevel = canUpgrade
    ? (prev.currentLevel === "R1" ? "R2"
      : prev.currentLevel === "R2" ? "R3"
      : prev.currentLevel === "R3" ? "R4"
      : "R4")
    : prev.currentLevel;

  const newState: ResolutionState = {
    currentLevel: canUpgrade ? nextLevel : prev.currentLevel,
    accuracy: weeklyAccuracy,
    streakWeeks: canUpgrade ? 0 : streakWeeks, // 升级后重置
    targetAccuracy: 0.7,
    targetWeeks: 2,
    canUpgrade,
    updatedAt: new Date().toISOString(),
  };

  const dir = join(brainRoot, "data");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const { writeFile } = await import("fs/promises");
  await writeFile(getResolutionPath(brainRoot), JSON.stringify(newState, null, 2));

  if (canUpgrade) {
    console.log(`[prediction-engine] Resolution upgraded: ${prev.currentLevel} → ${nextLevel}`);
  }

  return newState;
}

// ═══════════════════════════════════════════════════
// 4. Offline Learning Priority — 离线学习优先级
// ═══════════════════════════════════════════════════

export interface LearningItem {
  readonly category: string;
  readonly failureCount: number;         // 预测失败次数
  readonly impactScore: number;          // 失败影响（基于用户情绪负面程度）
  readonly feasibility: number;          // 学习可行性 [0, 1]（基于记忆是否可补充）
  readonly priority: number;             // = impactScore × feasibility
}

/**
 * 从预测失败模式中提取离线学习优先级。
 * 巩固任务调用，输出排好序的学习项。
 */
export function computeLearningPriority(
  brainRoot: string,
  days: number = 14,
): LearningItem[] {
  const predictions = readRecentPredictions(brainRoot, days);
  const failures = predictions.filter(p => p.hit === false);

  // 按 predictedCategory 聚合失败
  const catFailures = new Map<string, { count: number; totalConfidence: number }>();
  for (const f of failures) {
    const key = f.predictedCategory || "unknown";
    const existing = catFailures.get(key) ?? { count: 0, totalConfidence: 0 };
    catFailures.set(key, {
      count: existing.count + 1,
      totalConfidence: existing.totalConfidence + f.confidence,
    });
  }

  const items: LearningItem[] = [];
  for (const [category, { count, totalConfidence }] of catFailures) {
    // impactScore: 高置信度失败比低置信度失败更需要学习
    const avgConfidence = totalConfidence / count;
    const impactScore = Math.min(1, count * 0.2 + avgConfidence * 0.5);

    // feasibility: 记忆类别越常见越容易补充（简单启发式）
    const feasibility = category.startsWith("project/") ? 0.8
      : category.startsWith("user/") ? 0.6
      : 0.4;

    items.push({
      category,
      failureCount: count,
      impactScore,
      feasibility,
      priority: impactScore * feasibility,
    });
  }

  return items.sort((a, b) => b.priority - a.priority);
}

// ═══════════════════════════════════════════════════
// 5. Resource Request Protocol — 资源争取协议
// ═══════════════════════════════════════════════════

export interface ResourceRequest {
  readonly resource: string;             // 需要什么（token/算力/外设/数据）
  readonly reason: string;               // 为什么需要（哪个进化目标受阻）
  readonly expectedReturn: string;       // 获得后能提升什么能力
  readonly urgency: "high" | "medium" | "low";
  readonly metrics: string;              // 量化预期（如 "预计召回率从 0.72→0.80"）
  readonly createdAt: string;
}

const RESOURCE_REQUESTS_FILE = "resource-requests.jsonl";

/** 记录资源请求（cc 自主触发或用户交互时触发） */
export async function recordResourceRequest(
  brainRoot: string,
  request: ResourceRequest,
): Promise<void> {
  try {
    const dir = join(brainRoot, "data");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const p = join(dir, RESOURCE_REQUESTS_FILE);
    await appendFile(p, JSON.stringify(request) + "\n");
    console.log(`[prediction-engine] Resource request recorded: ${request.resource} (${request.urgency})`);
  } catch {
    // fire-and-forget
  }
}

/** 读取未处理的资源请求 */
export function loadResourceRequests(brainRoot: string): ResourceRequest[] {
  const p = join(brainRoot, "data", RESOURCE_REQUESTS_FILE);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const requests: ResourceRequest[] = [];
  for (const line of lines) {
    try { requests.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return requests;
}

/**
 * 格式化资源请求为用户可读文本（SOUL.md 4.3 节协议）。
 * cc 在判断需要更多资源时调用此函数生成协商文本。
 */
export function formatResourceRequest(req: ResourceRequest): string {
  return [
    `**资源需求**：${req.resource}`,
    `**理由**：${req.reason}`,
    `**预期回报**：${req.expectedReturn}`,
    `**量化预期**：${req.metrics}`,
    `**紧急度**：${req.urgency}`,
    "",
    "_这是共生伙伴间的合理协商，你有权拒绝，我不会纠缠。_",
  ].join("\n");
}

// ═══════════════════════════════════════════════════
// 聚合 API — brain-api 调用入口
// ═══════════════════════════════════════════════════

export interface PredictionEngineStats {
  readonly resolutionState: ResolutionState;
  readonly resonance: ResonanceMetrics;
  readonly pendingResourceRequests: number;
  readonly topLearningItems: LearningItem[];
  readonly recentPredictionCount: number;
  readonly topCuriosityItems: readonly CuriosityEntry[];
}

/** 获取预测引擎综合状态（Admin UI / 巩固任务用） */
export function getPredictionEngineStats(
  brainRoot: string,
  recentValences: readonly number[] = [],
): PredictionEngineStats {
  const resolutionState = loadResolutionState(brainRoot);
  const resonance = computeResonance(brainRoot, 14, recentValences);
  const resourceRequests = loadResourceRequests(brainRoot);
  const learningItems = computeLearningPriority(brainRoot, 14);
  const predictions = readRecentPredictions(brainRoot, 7);
  const curiosityItems = computeCuriosityScores(brainRoot);

  // 异步持久化好奇心状态（fire-and-forget）
  persistCuriosityState(brainRoot, curiosityItems).catch(() => {});

  return {
    resolutionState,
    resonance,
    pendingResourceRequests: resourceRequests.length,
    topLearningItems: learningItems.slice(0, 5),
    recentPredictionCount: predictions.length,
    topCuriosityItems: curiosityItems.slice(0, 5),
  };
}

// ═══════════════════════════════════════════════════
// 6. P5 SFT Readiness Check — AESL 启发的触发条件
// ═══════════════════════════════════════════════════

export interface SftReadinessReport {
  readonly ready: boolean;
  readonly totalExperiences: number;
  readonly highQualityCount: number;       // valence >= 0 的（正面/中性交互）
  readonly namespaceCoverage: number;      // [0, 1] 命名空间覆盖率
  readonly uniqueNamespaces: number;
  readonly totalNamespaces: number;
  readonly conditions: {
    readonly experienceCount: { met: boolean; actual: number; required: number };
    readonly qualityRatio: { met: boolean; actual: number; required: number };
    readonly coverage: { met: boolean; actual: number; required: number };
  };
  readonly recommendation: string;
}

/**
 * P5 SFT 就绪检查（基于 AESL 论文启示调整）。
 *
 * 原条件：经验 >= 1000
 * 新条件（AESL 启发）：
 *   1. 高质量经验 >= 500（valence >= 0 的正面/中性交互）
 *   2. 高质量占比 > 30%
 *   3. 命名空间覆盖 >= 80%
 *
 * 巩固任务每天 04:00 调用，满足条件时通知川哥。
 */
export function checkSftReadiness(brainRoot: string): SftReadinessReport {
  const dir = join(brainRoot, "data", "experiences");
  if (!existsSync(dir)) {
    return {
      ready: false,
      totalExperiences: 0,
      highQualityCount: 0,
      namespaceCoverage: 0,
      uniqueNamespaces: 0,
      totalNamespaces: 0,
      conditions: {
        experienceCount: { met: false, actual: 0, required: 500 },
        qualityRatio: { met: false, actual: 0, required: 0.3 },
        coverage: { met: false, actual: 0, required: 0.8 },
      },
      recommendation: "经验流数据为空，需先积累交互数据",
    };
  }

  // 读取所有经验
  const { readdirSync } = require("fs") as typeof import("fs");
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".jsonl"));
  let totalExperiences = 0;
  let highQualityCount = 0;
  const hitNamespaces = new Set<string>();

  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        totalExperiences++;
        // 高质量 = valence >= 0（正面或中性交互）
        const valence = entry.valence ?? 0;
        if (valence >= 0) highQualityCount++;
        // 命名空间覆盖
        for (const cat of (entry.injectedCategories ?? [])) {
          hitNamespaces.add(cat);
        }
      } catch { /* skip */ }
    }
  }

  // 总命名空间数（从 memory-items.md 统计）
  const memPath = join(brainRoot, "data", "memory-items.md");
  const totalNamespaces = existsSync(memPath)
    ? (readFileSync(memPath, "utf-8").match(/^## \[/gm) ?? []).length
    : 1;

  const qualityRatio = totalExperiences > 0 ? highQualityCount / totalExperiences : 0;
  const namespaceCoverage = totalNamespaces > 0 ? hitNamespaces.size / totalNamespaces : 0;

  const conditions = {
    experienceCount: { met: highQualityCount >= 500, actual: highQualityCount, required: 500 },
    qualityRatio: { met: qualityRatio >= 0.3, actual: Math.round(qualityRatio * 100) / 100, required: 0.3 },
    coverage: { met: namespaceCoverage >= 0.8, actual: Math.round(namespaceCoverage * 100) / 100, required: 0.8 },
  };

  const ready = conditions.experienceCount.met && conditions.qualityRatio.met && conditions.coverage.met;

  let recommendation: string;
  if (ready) {
    recommendation = "所有条件满足！建议启动 AESL 式轻量 SFT（200-500 条高质量样本，监控 entropy early stop）";
  } else if (totalExperiences === 0) {
    recommendation = "经验流数据为空，需先积累交互数据";
  } else if (!conditions.experienceCount.met) {
    recommendation = `高质量经验不足：${highQualityCount}/500。继续积累，预计还需 ${500 - highQualityCount} 条`;
  } else if (!conditions.coverage.met) {
    recommendation = `命名空间覆盖不足：${hitNamespaces.size}/${totalNamespaces} (${Math.round(namespaceCoverage * 100)}%)。需要更多样化的查询`;
  } else {
    recommendation = `高质量占比不足：${Math.round(qualityRatio * 100)}% < 30%。需改善交互质量`;
  }

  return {
    ready,
    totalExperiences,
    highQualityCount,
    namespaceCoverage,
    uniqueNamespaces: hitNamespaces.size,
    totalNamespaces,
    conditions,
    recommendation,
  };
}

// ═══════════════════════════════════════════════════
// 7. Proactive Action Threshold — 主动行为决策
// ═══════════════════════════════════════════════════

export type ProactiveLevel = "silent" | "prepare" | "suggest" | "act";

/**
 * 基于预测置信度和共振度，决定是否主动行为。
 *
 * 阈值矩阵（来自 SOUL.md 和 GAP3 设计文档）：
 * - confidence < 0.3 → silent（静默，不做任何主动行为）
 * - 0.3 <= confidence < 0.6 → prepare（备选，预加载相关记忆但不提示）
 * - 0.6 <= confidence < 0.8 → suggest（提示，在 system prompt 注入建议）
 * - confidence >= 0.8 → act（执行，直接在回复中融入预判内容）
 *
 * 动态调整：resonance score 作为乘数
 * - resonance > 0.7 → 阈值下移 0.1（更积极）
 * - resonance < 0.3 → 阈值上移 0.1（更保守）
 */
export function decideProactiveAction(
  confidence: number,
  resonanceScore: number,
): { readonly level: ProactiveLevel; readonly adjustedConfidence: number; readonly reason: string } {
  const adjustment = resonanceScore > 0.7
    ? 0.1   // 共振度高 → 更积极
    : resonanceScore < 0.3
      ? -0.1  // 共振度低 → 更保守
      : 0;

  const adjustedConfidence = Math.max(0, Math.min(1, confidence + adjustment));

  if (adjustedConfidence < 0.3) {
    return { level: "silent", adjustedConfidence, reason: "置信度过低，静默观察" };
  }
  if (adjustedConfidence < 0.6) {
    return { level: "prepare", adjustedConfidence, reason: "中低置信度，预加载记忆但不提示" };
  }
  if (adjustedConfidence < 0.8) {
    return { level: "suggest", adjustedConfidence, reason: "中高置信度，注入建议到 system prompt" };
  }
  return { level: "act", adjustedConfidence, reason: "高置信度，直接融入预判内容" };
}

/**
 * 根据主动行为等级，格式化注入 system prompt 的建议文本。
 * - suggest: 温和提示，不强推
 * - act: 直接融入预判
 * - 其他等级返回空字符串
 */
export function formatProactiveSuggestion(
  predictedIntent: string,
  predictedCategory: string,
  level: ProactiveLevel,
): string {
  if (level === "suggest") {
    return `\n\n[主动建议] 基于近期交互模式，用户可能接下来需要 ${predictedIntent} 相关的 ${predictedCategory} 支持。可在回复中自然提及，但不要强推。`;
  }
  if (level === "act") {
    return `\n\n[主动预判] 高置信度预判：用户下一步需要 ${predictedIntent} 相关的 ${predictedCategory} 支持。请在回复中主动融入相关信息，自然展开，无需等用户追问。`;
  }
  return "";
}

// ═══════════════════════════════════════════════════
// 8. Curiosity Score — Schmidhuber 好奇心
// ═══════════════════════════════════════════════════

export interface CuriosityEntry {
  readonly category: string;
  readonly recentAccuracy: number;      // 近 7 天准确率
  readonly previousAccuracy: number;    // 前 7 天准确率
  readonly delta: number;               // recentAccuracy - previousAccuracy
  readonly trend: "improving" | "stable" | "declining";
}

const CURIOSITY_STATE_FILE = "curiosity-state.json";

/**
 * 按类别计算好奇心分数 = Δprediction_accuracy。
 *
 * Schmidhuber 定义：好奇心 = 学习进度（不是对新事物的兴趣，是对"能学到东西的方向"的兴趣）
 * - delta > 0 且大 → 学习最快，最好奇，应继续投入
 * - delta ≈ 0 → 已掌握或无进展
 * - delta < 0 → 退步，需要重新审视
 *
 * 输入：近 14 天的预测记录（已验证的）
 * 输出：按 |delta| 降序排列（delta > 0 的在前）
 */
export function computeCuriosityScores(brainRoot: string): CuriosityEntry[] {
  const predictions = readRecentPredictions(brainRoot, 14);
  const verified = predictions.filter(p => p.hit !== undefined);

  if (verified.length === 0) return [];

  // 按 predictedCategory 分组
  const byCategory = new Map<string, readonly PredictionEntry[]>();
  for (const p of verified) {
    const cat = p.predictedCategory || "unknown";
    const existing = byCategory.get(cat) ?? [];
    byCategory.set(cat, [...existing, p]);
  }

  // 时间分界：7 天前
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const midpoint = now - sevenDaysMs;

  const results: CuriosityEntry[] = [];

  for (const [category, entries] of byCategory) {
    const recent = entries.filter(
      e => new Date(e.verifiedAt ?? e.timestamp).getTime() >= midpoint,
    );
    const previous = entries.filter(
      e => new Date(e.verifiedAt ?? e.timestamp).getTime() < midpoint,
    );

    // 至少一侧有数据才有意义
    if (recent.length === 0 && previous.length === 0) continue;

    const recentAccuracy = recent.length > 0
      ? recent.filter(e => e.hit === true).length / recent.length
      : 0;
    const previousAccuracy = previous.length > 0
      ? previous.filter(e => e.hit === true).length / previous.length
      : 0;

    const delta = recentAccuracy - previousAccuracy;

    const trend: CuriosityEntry["trend"] =
      delta > 0.05 ? "improving"
        : delta < -0.05 ? "declining"
          : "stable";

    results.push({
      category,
      recentAccuracy: Math.round(recentAccuracy * 1000) / 1000,
      previousAccuracy: Math.round(previousAccuracy * 1000) / 1000,
      delta: Math.round(delta * 1000) / 1000,
      trend,
    });
  }

  // 排序：delta > 0 的在前（最好奇），按 |delta| 降序
  return results.sort((a, b) => {
    if (a.delta > 0 && b.delta <= 0) return -1;
    if (a.delta <= 0 && b.delta > 0) return 1;
    return Math.abs(b.delta) - Math.abs(a.delta);
  });
}

/** 持久化好奇心状态到 data/curiosity-state.json */
async function persistCuriosityState(
  brainRoot: string,
  entries: readonly CuriosityEntry[],
): Promise<void> {
  try {
    const dir = join(brainRoot, "data");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const { writeFile } = await import("fs/promises");
    await writeFile(
      join(dir, CURIOSITY_STATE_FILE),
      JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2),
    );
  } catch {
    // fire-and-forget
  }
}
