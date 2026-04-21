// @evodesk/shared — 跨层类型定义 V1
// 三层共享：Desktop Shell / Brain Kernel / Rust Sidecar
// Day 3 冻结，后续只允许 additive changes

// ============================================================
// 消息
// ============================================================

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly timestamp: number;
  readonly sessionId: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly sessionId: string;
  readonly model?: string;
  readonly stream?: boolean;
}

export interface ChatStreamChunk {
  readonly type: 'text' | 'thinking' | 'tool_call' | 'done' | 'error' | 'warning';
  readonly content: string;
  readonly timestamp: number;
}

export interface ChatResponse {
  readonly message: ChatMessage;
  readonly usage?: TokenUsage;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

// ============================================================
// 记忆 — MemCell 四类信息
// ============================================================

export interface EpisodicTrace {
  readonly event: string;
  readonly context: string;
  readonly timestamp: number;
}

export interface AtomicFact {
  readonly statement: string;
  readonly domain: string;
  readonly confidence: number;
  readonly source: string;
}

export interface ForesightSignal {
  readonly signal: string;
  readonly relevance: number;
  readonly detectedAt: number;
}

export interface AgentCase {
  readonly action: string;
  readonly outcome: 'success' | 'failure' | 'partial';
  readonly lesson: string;
}

export interface MemCell {
  readonly id: string;
  readonly sessionId: string;
  readonly episodicTraces: readonly EpisodicTrace[];
  readonly atomicFacts: readonly AtomicFact[];
  readonly foresightSignals: readonly ForesightSignal[];
  readonly agentCases: readonly AgentCase[];
  readonly contentHash: string;
  readonly createdAt: number;
}

// ============================================================
// 记忆 — Compiled Truth (可变结论)
// ============================================================

export interface CompiledTruth {
  readonly id: string;
  readonly domain: string;
  readonly statement: string;
  readonly confidence: number;
  readonly validAt: number;
  readonly invalidAt?: number;
  readonly sourceMemCellIds: readonly string[];
}

// ============================================================
// 记忆 — Timeline (证据链，append-only)
// ============================================================

export interface TimelineEntry {
  readonly id: string;
  readonly event: string;
  readonly source: string;
  readonly firstSeen: number;
  readonly occurrences: number;
  readonly relatedMemCellIds: readonly string[];
}

// ============================================================
// Agent Loop
// ============================================================

export type AgentLoopPhase =
  | 'perceive'
  | 'plan'
  | 'act'
  | 'verify'
  | 'reflect'
  | 'consolidate';

export interface AgentLoopState {
  readonly phase: AgentLoopPhase;
  readonly sessionId: string;
  readonly turnCount: number;
  readonly startedAt: number;
}

// ============================================================
// 心流 — Task Record & 降智检测
// ============================================================

export interface TaskRecord {
  readonly id: string;
  readonly domain: string;
  readonly toolCallsRequired: number;
  readonly estimatedSteps: number;
  readonly memoryRetrievalCount: number;
  readonly similarTaskSuccessRate: number;
  readonly isReversible: boolean;
  readonly success: boolean;
  readonly retryCount: number;
  readonly userCorrected: boolean;
  readonly completedAt: number;
}

export interface DegradationMetrics {
  readonly thinkingRatio: number;
  readonly templateSimilarity: number;
  readonly toolSkipRate: number;
  readonly verificationSkipped: boolean;
  readonly firstDraftAccepted: boolean;
  readonly taskComplexity: number;
}

export type FlowState = 'FLOW' | 'BOREDOM' | 'ANXIETY' | 'APATHY';

export interface FlowBoostInfo {
  readonly active: boolean;
  readonly state: FlowState;
  readonly prompt: string;
}

export interface FlowMetrics {
  readonly challengeRatio: number;
  readonly skillLevel: number;
  readonly taskComplexity: number;
  readonly isDegrading: boolean;
  readonly flowState: FlowState;
  readonly boost?: FlowBoostInfo;
  readonly timestamp: number;
}

// ============================================================
// 会话 — Session 持久化
// ============================================================

export interface Session {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly closedAt?: number;
}

export interface SessionListResponse {
  readonly sessions: readonly Session[];
}

export interface SessionMessagesResponse {
  readonly messages: readonly ChatMessage[];
  readonly sessionId: string;
}

// ============================================================
// 记忆注入 — Brain Context
// ============================================================

export interface BrainContextResult {
  readonly context: string;
  readonly matchedDomains: readonly string[];
  readonly itemCount: number;
  readonly retrievalPaths: readonly string[];
}

// ============================================================
// 跨层通信 — Shell ↔ Brain HTTP API
// ============================================================

export interface HealthResponse {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly version: string;
  readonly uptime: number;
}

export interface MemoryListResponse {
  readonly truths: readonly CompiledTruth[];
  readonly timeline: readonly TimelineEntry[];
  readonly totalMemCells: number;
}

export type MemorySearchMode = 'fts' | 'hybrid';

export interface MemorySearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly domain?: string;
  readonly mode?: MemorySearchMode;
}

export interface MemorySearchResponse {
  readonly results: readonly CompiledTruth[];
  readonly queryTimeMs: number;
}

// ============================================================
// 跨层通信 — Brain ↔ Sidecar HTTP API (端口 19081)
// ============================================================

export interface EmbeddingRequest {
  readonly texts: readonly string[];
  readonly model?: string;
}

export interface EmbeddingResponse {
  readonly embeddings: readonly (readonly number[])[];
  readonly dimensions: number;
}

export interface FtsIndexRequest {
  readonly id: string;
  readonly content: string;
  readonly category: string;
}

export interface FtsSearchRequest {
  readonly query: string;
  readonly limit: number;
}

export interface FtsSearchResult {
  readonly id: string;
  readonly content: string;
  readonly category: string;
  readonly score: number;
}

export interface ContentHashRequest {
  readonly content: string;
}

export interface ContentHashResponse {
  readonly hash: string;
}

// ============================================================
// Provider 配置
// ============================================================

export interface ProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly type: 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'custom';
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly ModelConfig[];
  readonly enabled: boolean;
}

export interface ModelConfig {
  readonly id: string;
  readonly name: string;
  readonly maxTokens: number;
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;
}

// ============================================================
// 操作定义 — operations 契约层会引用
// ============================================================

export type OperationName =
  | 'chat'
  | 'chat.stream'
  | 'memory.search'
  | 'memory.list'
  | 'memory.extract'
  | 'health'
  | 'provider.list'
  | 'flow.metrics'
  | 'session.create'
  | 'session.list'
  | 'session.get'
  | 'session.messages';

export interface OperationMeta {
  readonly name: OperationName;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly description: string;
}
