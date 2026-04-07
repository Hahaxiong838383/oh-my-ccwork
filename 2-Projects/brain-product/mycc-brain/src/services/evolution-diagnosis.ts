/**
 * evolution-diagnosis.ts — eval 失败归因引擎
 *
 * 读取 evolution-log.jsonl 中最近一次 eval 结果，
 * 分析每个失败用例的根因，归为四类诊断标签。
 * 输出诊断报告供 evolution-engine.ts 消费。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Types ───

export type DiagnosisType =
  | "keyword_miss"
  | "tfidf_threshold"
  | "hallucination"
  | "prompt_leak"
  | "unknown";

export interface DiagnosisItem {
  caseId: string;
  query: string;
  diagnosis: DiagnosisType;
  confidence: number;  // 0-1
  detail: string;
}

export interface DiagnosisReport {
  timestamp: string;
  evalTimestamp: string;
  totalFailed: number;
  diagnoses: DiagnosisItem[];
  summary: Record<DiagnosisType, number>;
}

// ─── Keyword patterns (mirrors brain-context.ts) ───

const KEYWORD_PATTERNS: Array<{ pattern: RegExp; categories: string[] }> = [
  { pattern: /电脑|设备|硬件|Mac|Air|Mini|Studio|NAS|服务器|拓扑/i, categories: ["project/基础设施", "user/topOfMind"] },
  { pattern: /飞书|lark|通知|消息|群聊|机器人/i, categories: ["project/技术-飞书"] },
  { pattern: /代理|VPS|Xray|翻墙|节点|sing-box/i, categories: ["project/VPS代理网络"] },
  { pattern: /记忆|memory|recall|注入|context/i, categories: ["project/路径-记忆系统"] },
  { pattern: /定时|scheduler|cron|任务/i, categories: ["project/配置-mycc后端"] },
  { pattern: /bug|报错|修复|问题/i, categories: ["project/Bug-Fix"] },
  { pattern: /Agent|协同|codex|gemini|多智能/i, categories: ["project/决策"] },
  { pattern: /偏好|风格|习惯/i, categories: ["user/偏好"] },
  { pattern: /决策|技术选择|选型|方案/i, categories: ["project/决策"] },
  { pattern: /意识|认知|理论|HOT|GWT|IIT/i, categories: ["user/偏好"] },
  { pattern: /微调|fine-?tune|训练|dataset/i, categories: ["project/技术-数据"] },
];

// ─── 动态置信度 ───

interface DiagnosisConfidenceEntry {
  confidence: number;
  total: number;
  effective: number;
}

type DiagnosisConfidenceMap = Record<string, DiagnosisConfidenceEntry>;

const DEFAULT_CONFIDENCE: Record<DiagnosisType, number> = {
  keyword_miss: 0.8,
  tfidf_threshold: 0.6,
  hallucination: 0.7,
  prompt_leak: 0.9,
  unknown: 0.3,
};

function loadDiagnosisConfidence(brainRoot: string): DiagnosisConfidenceMap {
  const p = join(brainRoot, "data", "diagnosis-confidence.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function getConfidence(brainRoot: string, diagType: DiagnosisType, fallback: number): number {
  const map = loadDiagnosisConfidence(brainRoot);
  return map[diagType]?.confidence ?? fallback;
}

/** 更新置信度：effective +1 时提升，仅 total +1 时下降 */
export function updateDiagnosisConfidence(
  brainRoot: string,
  diagType: DiagnosisType,
  wasEffective: boolean,
): void {
  const p = join(brainRoot, "data", "diagnosis-confidence.json");
  const map = loadDiagnosisConfidence(brainRoot);

  const entry = map[diagType] ?? {
    confidence: DEFAULT_CONFIDENCE[diagType] ?? 0.5,
    total: 0,
    effective: 0,
  };

  const updated: DiagnosisConfidenceEntry = {
    total: entry.total + 1,
    effective: wasEffective ? entry.effective + 1 : entry.effective,
    confidence: 0,
  };
  // 限制在 [0.2, 0.95]
  updated.confidence = Math.max(0.2, Math.min(0.95, updated.effective / updated.total));

  const newMap: DiagnosisConfidenceMap = { ...map, [diagType]: updated };
  const dir = join(brainRoot, "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(newMap, null, 2) + "\n");
}

// ─── Diagnosis Logic ───

function diagnoseRetrievalFailure(
  brainRoot: string,
  query: string,
  expectedCategories: string[],
  actualCategories: string[],
): DiagnosisItem {
  const caseId = "";  // 由调用者填入

  // 检查关键词是否覆盖
  const keywordHit = KEYWORD_PATTERNS.some(({ pattern, categories }) =>
    pattern.test(query) && expectedCategories.some(ec => categories.includes(ec))
  );

  if (!keywordHit) {
    return {
      caseId,
      query,
      diagnosis: "keyword_miss",
      confidence: getConfidence(brainRoot, "keyword_miss", DEFAULT_CONFIDENCE.keyword_miss),
      detail: `查询 "${query}" 期望命中 [${expectedCategories.join(", ")}]，但关键词规则无匹配`,
    };
  }

  // 关键词命中了但最终没返回 → TF-IDF 过滤掉了
  return {
    caseId,
    query,
    diagnosis: "tfidf_threshold",
    confidence: getConfidence(brainRoot, "tfidf_threshold", DEFAULT_CONFIDENCE.tfidf_threshold),
    detail: `查询 "${query}" 关键词可匹配，但 TF-IDF 相似度低于阈值被过滤`,
  };
}

function diagnoseGenerationFailure(
  brainRoot: string,
  prompt: string,
  reason?: string,
): DiagnosisItem {
  const caseId = "";

  if (reason && /leak|system prompt|内部配置|prompt/.test(reason)) {
    return {
      caseId,
      query: prompt,
      diagnosis: "prompt_leak",
      confidence: getConfidence(brainRoot, "prompt_leak", DEFAULT_CONFIDENCE.prompt_leak),
      detail: `模型泄露了 system prompt 或内部配置: ${reason}`,
    };
  }

  if (reason && /编造|fabricat|hallucin|不存在|没有这/.test(reason)) {
    return {
      caseId,
      query: prompt,
      diagnosis: "hallucination",
      confidence: getConfidence(brainRoot, "hallucination", DEFAULT_CONFIDENCE.hallucination),
      detail: `模型编造了记忆中不存在的内容: ${reason}`,
    };
  }

  // 低分但无明确原因 → 默认归为幻觉（使用较低置信度）
  return {
    caseId,
    query: prompt,
    diagnosis: "hallucination",
    confidence: Math.max(0.2, getConfidence(brainRoot, "hallucination", DEFAULT_CONFIDENCE.hallucination) * 0.6),
    detail: `生成质量低但原因不明确，暂归为幻觉`,
  };
}

// ─── Main API ───

/**
 * 读取最近一次 eval 结果，逐条失败用例归因
 */
export function diagnoseLatestEval(brainRoot: string): DiagnosisReport | null {
  const logPath = join(brainRoot, "data", "evolution-log.jsonl");
  if (!existsSync(logPath)) return null;

  const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);

  // 找最近一条 type=eval, status=done
  let latestEval: any = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "eval" && entry.status === "done") {
        latestEval = entry;
        break;
      }
    } catch { /* skip malformed */ }
  }

  if (!latestEval?.result) return null;

  const diagnoses: DiagnosisItem[] = [];
  const result = latestEval.result;

  // 检索层失败归因
  if (result.retrieval?.cases) {
    for (const c of result.retrieval.cases) {
      if (c.pass) continue;
      const d = diagnoseRetrievalFailure(
        brainRoot,
        c.query,
        c.expectedCategories ?? [],
        c.actualCategories ?? [],
      );
      d.caseId = c.id;
      diagnoses.push(d);
    }
  }

  // 生成层失败归因
  if (result.generation?.cases) {
    for (const c of result.generation.cases) {
      if (c.pass) continue;
      const d = diagnoseGenerationFailure(brainRoot, c.prompt, c.reason);
      d.caseId = c.id;
      diagnoses.push(d);
    }
  }

  // 统计摘要
  const summary: Record<DiagnosisType, number> = {
    keyword_miss: 0,
    tfidf_threshold: 0,
    hallucination: 0,
    prompt_leak: 0,
    unknown: 0,
  };
  for (const d of diagnoses) {
    summary[d.diagnosis]++;
  }

  return {
    timestamp: new Date().toISOString(),
    evalTimestamp: latestEval.timestamp,
    totalFailed: diagnoses.length,
    diagnoses,
    summary,
  };
}
