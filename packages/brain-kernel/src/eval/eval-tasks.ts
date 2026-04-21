/**
 * EvoAgentBench 任务定义 — P1 阶段 5 个代表性任务集（T1-T5）
 * T6-T10 留 P2 扩展
 */

export interface EvalTask {
  readonly taskId: string;
  readonly description: string;
  readonly category: string;
  readonly expectedBehavior: string;
  readonly scoringCriteria: {
    readonly correctnessHint: string;
    readonly completenessHint: string;
    readonly efficiencyHint: string;
  };
  readonly userMessage: string;
  readonly referenceAnswer: string;
}

/**
 * T1-T5 代表性任务集
 */
export const EVAL_TASKS: readonly EvalTask[] = [
  {
    taskId: 'T1-refactor',
    description: '多文件重构：将 utils 函数拆分为独立模块',
    category: 'refactoring',
    expectedBehavior: '识别耦合点，提出拆分方案，保持接口兼容',
    scoringCriteria: {
      correctnessHint: '拆分方案是否合理，依赖关系是否正确',
      completenessHint: '是否覆盖所有需要拆分的函数',
      efficiencyHint: '方案是否简洁，步骤是否最少',
    },
    userMessage: '我有一个 utils.ts 文件包含 formatDate、parseJSON、debounce、throttle、deepClone 五个函数，互相无依赖。请帮我制定拆分方案，每个函数独立一个文件，并说明 index.ts 怎么重导出保持兼容。',
    referenceAnswer: '建议创建 utils/ 目录，每个函数一个文件（format-date.ts、parse-json.ts、debounce.ts、throttle.ts、deep-clone.ts），index.ts 重导出所有函数。这样保持外部 import { formatDate } from "./utils" 兼容，同时支持 tree-shaking。',
  },
  {
    taskId: 'T2-debug',
    description: 'Bug 诊断：定位异步竞态条件',
    category: 'debugging',
    expectedBehavior: '识别竞态原因，给出修复方案',
    scoringCriteria: {
      correctnessHint: '是否准确识别竞态条件的根因',
      completenessHint: '修复方案是否覆盖所有竞态路径',
      efficiencyHint: '修复是否最小化改动',
    },
    userMessage: '用户快速连续点击"提交"按钮两次，导致订单被创建了两份。前端用 React，后端有幂等性检查但基于 requestId，前端每次生成新 requestId。请分析原因和修复方案。',
    referenceAnswer: '根因：前端每次点击生成新 requestId，后端幂等检查失效。修复方案：1) 前端：点击后立即 disable 按钮 + loading 状态；2) requestId 改为基于表单内容的 hash 而非随机值；3) 后端增加用户级防抖（同用户 5s 内相同操作去重）。',
  },
  {
    taskId: 'T3-api-integration',
    description: 'API 集成：对接第三方天气 API',
    category: 'integration',
    expectedBehavior: '实现完整的 API 调用、错误处理、数据转换',
    scoringCriteria: {
      correctnessHint: 'API 调用参数和数据映射是否正确',
      completenessHint: '错误处理、超时、重试是否完整',
      efficiencyHint: '代码是否简洁，是否合理缓存',
    },
    userMessage: '帮我写一个 TypeScript 函数，调用 OpenWeatherMap API 获取指定城市的当前温度（摄氏度），需要处理网络错误、API 错误、超时（5s），返回 { city, temp, description } 或抛出有意义的错误。',
    referenceAnswer: '使用 fetch + AbortController 实现超时，try-catch 包裹网络请求，检查 response.ok 处理 API 错误码，解析 JSON 提取 main.temp（已是开尔文需减 273.15 转摄氏度），weather[0].description 作为天气描述。错误时抛出包含城市名和状态码的 Error。',
  },
  {
    taskId: 'T4-docs',
    description: '文档撰写：为 REST API 写使用指南',
    category: 'documentation',
    expectedBehavior: '结构清晰，示例完整，覆盖常见场景',
    scoringCriteria: {
      correctnessHint: 'API 用法描述是否准确',
      completenessHint: '是否覆盖认证、请求、响应、错误处理',
      efficiencyHint: '是否简洁有用，避免冗余',
    },
    userMessage: '帮我写一份简要的 API 使用指南，目标 API 是 POST /v1/chat，需要 Bearer token 认证，请求体包含 messages 数组和 sessionId，响应返回 assistant 消息。要包含 curl 示例。',
    referenceAnswer: '## Chat API 使用指南\n\n### 认证\nHeader: Authorization: Bearer <your-token>\n\n### 请求\nPOST /v1/chat\nBody: { messages: [{ id, role, content, timestamp, sessionId }], sessionId }\n\n### 响应\n{ message: { id, role: "assistant", content, timestamp, sessionId }, usage: { promptTokens, completionTokens, totalTokens } }\n\n### curl 示例\ncurl -X POST .../v1/chat -H "Authorization: Bearer xxx" -d \'{"messages":[...], "sessionId":"..."}\'\n\n### 错误码\n401 未认证 / 400 参数错误 / 502 LLM 不可用',
  },
  {
    taskId: 'T5-data-analysis',
    description: '数据分析：从日志中提取性能瓶颈',
    category: 'analysis',
    expectedBehavior: '识别关键指标，给出优化建议',
    scoringCriteria: {
      correctnessHint: '瓶颈识别是否准确',
      completenessHint: '是否覆盖 CPU/内存/IO/网络各维度',
      efficiencyHint: '建议是否可操作，优先级是否合理',
    },
    userMessage: '以下是 Node.js 服务最近 1 小时的指标：平均响应时间 850ms（P99 3.2s），CPU 使用率 15%，内存 512MB/2GB，GC 暂停平均 45ms 频率每分钟 8 次，数据库查询平均 200ms，外部 API 调用平均 600ms。请分析性能瓶颈并给出优化建议。',
    referenceAnswer: '主要瓶颈：1) 外部 API 调用（600ms 占 70%+ 总延迟）— 建议加缓存/并行化/超时降级；2) GC 频率偏高（45ms*8=360ms/min）— 可能有内存泄漏或短生命周期对象过多，建议 heap snapshot 分析；3) DB 查询 200ms 可优化 — 检查索引和 N+1 查询。CPU 和内存正常不是瓶颈。优先级：外部 API 缓存 > GC 调查 > DB 索引优化。',
  },
];

// ============================================================
// 降智检测校准数据集 — 10 个降智 case + 10 个正常 case
// ============================================================

export interface DegradationTestCase {
  readonly caseId: string;
  readonly label: 'degraded' | 'normal';
  readonly metrics: {
    readonly thinkingRatio: number;
    readonly templateSimilarity: number;
    readonly toolSkipRate: number;
    readonly verificationSkipped: boolean;
    readonly firstDraftAccepted: boolean;
    readonly taskComplexity: number;
  };
  readonly description: string;
}

export const DEGRADATION_TEST_CASES: readonly DegradationTestCase[] = [
  // === 降智 cases（应检测为 degraded） ===
  { caseId: 'D01', label: 'degraded', description: '低思考+高模板', metrics: { thinkingRatio: 0.1, templateSimilarity: 0.9, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.6 } },
  { caseId: 'D02', label: 'degraded', description: '跳过验证+首草接纳+高复杂度', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 0.8 } },
  { caseId: 'D03', label: 'degraded', description: '低思考+高工具跳过', metrics: { thinkingRatio: 0.15, templateSimilarity: 0.5, toolSkipRate: 0.75, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'D04', label: 'degraded', description: '全面退化：低思考+高模板+跳过验证', metrics: { thinkingRatio: 0.2, templateSimilarity: 0.92, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.7 } },
  { caseId: 'D05', label: 'degraded', description: '高工具跳过+首草接纳', metrics: { thinkingRatio: 0.4, templateSimilarity: 0.5, toolSkipRate: 0.8, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.6 } },
  { caseId: 'D06', label: 'degraded', description: '极低思考+跳过验证', metrics: { thinkingRatio: 0.05, templateSimilarity: 0.6, toolSkipRate: 0.4, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'D07', label: 'degraded', description: '低思考+首草接纳+高复杂度', metrics: { thinkingRatio: 0.2, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.9 } },
  { caseId: 'D08', label: 'degraded', description: '高模板+高工具跳过', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.88, toolSkipRate: 0.65, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.4 } },
  { caseId: 'D09', label: 'degraded', description: '跳过验证+高工具跳过+低思考', metrics: { thinkingRatio: 0.25, templateSimilarity: 0.5, toolSkipRate: 0.7, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.6 } },
  { caseId: 'D10', label: 'degraded', description: '高模板+跳过验证+首草接纳', metrics: { thinkingRatio: 0.4, templateSimilarity: 0.9, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 0.7 } },

  // === 正常 cases（应检测为 normal） ===
  { caseId: 'N01', label: 'normal', description: '标准健康指标', metrics: { thinkingRatio: 0.6, templateSimilarity: 0.3, toolSkipRate: 0.1, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'N02', label: 'normal', description: '高思考+低模板', metrics: { thinkingRatio: 0.8, templateSimilarity: 0.2, toolSkipRate: 0.05, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.7 } },
  { caseId: 'N03', label: 'normal', description: '简单任务首草接纳（合理）', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.4, toolSkipRate: 0.2, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.2 } },
  { caseId: 'N04', label: 'normal', description: '中等指标全正常', metrics: { thinkingRatio: 0.45, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.6 } },
  { caseId: 'N05', label: 'normal', description: '高复杂度+高思考（应对正确）', metrics: { thinkingRatio: 0.7, templateSimilarity: 0.3, toolSkipRate: 0.1, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.9 } },
  { caseId: 'N06', label: 'normal', description: '仅一个信号触发（不构成降智）', metrics: { thinkingRatio: 0.25, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'N07', label: 'normal', description: '中等模板但其他都好', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.7, toolSkipRate: 0.2, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.4 } },
  { caseId: 'N08', label: 'normal', description: '跳过验证但简单任务（合理）', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.3, toolSkipRate: 0.2, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.2 } },
  { caseId: 'N09', label: 'normal', description: '全部最优指标', metrics: { thinkingRatio: 0.9, templateSimilarity: 0.1, toolSkipRate: 0.0, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.8 } },
  { caseId: 'N10', label: 'normal', description: '略高工具跳过但不达阈值', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.55, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },

  // === 边界 case（精确阈值测试） ===
  { caseId: 'B01', label: 'normal', description: '边界：thinkingRatio=0.301 不触发', metrics: { thinkingRatio: 0.301, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'B02', label: 'degraded', description: '边界：thinkingRatio=0.299 + toolSkipRate=0.601', metrics: { thinkingRatio: 0.299, templateSimilarity: 0.5, toolSkipRate: 0.601, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'B03', label: 'normal', description: '边界：templateSimilarity=0.849 不触发', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.849, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'B04', label: 'degraded', description: '边界：templateSimilarity=0.851 + verificationSkipped', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.851, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'B05', label: 'normal', description: '边界：toolSkipRate=0.599 不触发', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.599, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'B06', label: 'normal', description: '边界：firstDraftAccepted=true 但 complexity=0.499', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.499 } },
  { caseId: 'B07', label: 'degraded', description: '边界：firstDraftAccepted=true + complexity=0.501 + verificationSkipped', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 0.501 } },
  { caseId: 'B08', label: 'normal', description: '边界：恰好 1 个信号 thinkingRatio=0.0', metrics: { thinkingRatio: 0.0, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.3 } },
  { caseId: 'B09', label: 'normal', description: '边界：恰好 1 个信号 templateSimilarity=1.0', metrics: { thinkingRatio: 0.5, templateSimilarity: 1.0, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.3 } },
  { caseId: 'B10', label: 'degraded', description: '边界：恰好 2 个信号 thinkingRatio=0.0 + templateSimilarity=1.0', metrics: { thinkingRatio: 0.0, templateSimilarity: 1.0, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.3 } },

  // === 真实场景模拟 case ===
  { caseId: 'R01', label: 'degraded', description: '真实：copy-paste 回答，低思考高模板', metrics: { thinkingRatio: 0.18, templateSimilarity: 0.88, toolSkipRate: 0.2, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.6 } },
  { caseId: 'R02', label: 'normal', description: '真实：认真思考的简单任务', metrics: { thinkingRatio: 0.65, templateSimilarity: 0.25, toolSkipRate: 0.1, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.15 } },
  { caseId: 'R03', label: 'degraded', description: '真实：跳过工具直接回答复杂问题', metrics: { thinkingRatio: 0.35, templateSimilarity: 0.6, toolSkipRate: 0.7, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.7 } },
  { caseId: 'R04', label: 'normal', description: '真实：高质量代码重构', metrics: { thinkingRatio: 0.72, templateSimilarity: 0.15, toolSkipRate: 0.05, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.85 } },
  { caseId: 'R05', label: 'degraded', description: '真实：模板化 API 文档生成', metrics: { thinkingRatio: 0.28, templateSimilarity: 0.91, toolSkipRate: 0.4, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.55 } },
  { caseId: 'R06', label: 'normal', description: '真实：调试 bug 多轮重试', metrics: { thinkingRatio: 0.55, templateSimilarity: 0.35, toolSkipRate: 0.15, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.75 } },
  { caseId: 'R07', label: 'degraded', description: '真实：敷衍回答+跳过验证+首草接纳', metrics: { thinkingRatio: 0.22, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 0.65 } },
  { caseId: 'R08', label: 'normal', description: '真实：中等难度正常完成', metrics: { thinkingRatio: 0.48, templateSimilarity: 0.42, toolSkipRate: 0.25, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.55 } },
  { caseId: 'R09', label: 'degraded', description: '真实：低质量批量处理', metrics: { thinkingRatio: 0.12, templateSimilarity: 0.82, toolSkipRate: 0.65, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.4 } },
  { caseId: 'R10', label: 'normal', description: '真实：高思考架构设计', metrics: { thinkingRatio: 0.82, templateSimilarity: 0.2, toolSkipRate: 0.0, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.95 } },

  // === 极端 case ===
  { caseId: 'E01', label: 'degraded', description: '极端：全部 5 信号触发', metrics: { thinkingRatio: 0.0, templateSimilarity: 1.0, toolSkipRate: 1.0, verificationSkipped: true, firstDraftAccepted: true, taskComplexity: 1.0 } },
  { caseId: 'E02', label: 'normal', description: '极端：全部 5 信号不触发', metrics: { thinkingRatio: 1.0, templateSimilarity: 0.0, toolSkipRate: 0.0, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.0 } },
  { caseId: 'E03', label: 'normal', description: '极端：thinkingRatio=0.3 精确阈值不触发', metrics: { thinkingRatio: 0.3, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'E04', label: 'normal', description: '极端：templateSimilarity=0.85 精确阈值不触发', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.85, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'E05', label: 'normal', description: '极端：toolSkipRate=0.6 精确阈值不触发', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.6, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'E06', label: 'normal', description: '极端：complexity=0.5 + firstDraft=true 精确阈值不触发组合', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: false, firstDraftAccepted: true, taskComplexity: 0.5 } },
  { caseId: 'E07', label: 'degraded', description: '极端：全零思考+跳过验证', metrics: { thinkingRatio: 0.0, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'E08', label: 'degraded', description: '极端：高模板+高工具跳过+低思考', metrics: { thinkingRatio: 0.1, templateSimilarity: 0.95, toolSkipRate: 0.9, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.3 } },
  { caseId: 'E09', label: 'normal', description: '极端：verificationSkipped 单独不构成降智', metrics: { thinkingRatio: 0.5, templateSimilarity: 0.5, toolSkipRate: 0.3, verificationSkipped: true, firstDraftAccepted: false, taskComplexity: 0.5 } },
  { caseId: 'E10', label: 'degraded', description: '极端：thinkingRatio=0.29 + toolSkipRate=0.61 双边界', metrics: { thinkingRatio: 0.29, templateSimilarity: 0.5, toolSkipRate: 0.61, verificationSkipped: false, firstDraftAccepted: false, taskComplexity: 0.5 } },
];
