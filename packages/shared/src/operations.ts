import type {
  OperationMeta,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  HealthResponse,
  MemoryListResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  FlowMetrics,
  ProviderConfig,
  Session,
  SessionListResponse,
  SessionMessagesResponse,
} from './types.js';

export const OPERATIONS: readonly OperationMeta[] = [
  {
    name: 'health',
    method: 'GET',
    path: '/health',
    description: 'Health check with version and uptime',
  },
  {
    name: 'chat',
    method: 'POST',
    path: '/v1/chat',
    description: 'Send message and receive complete response',
  },
  {
    name: 'chat.stream',
    method: 'POST',
    path: '/v1/chat/stream',
    description: 'Send message and receive SSE stream',
  },
  {
    name: 'memory.search',
    method: 'POST',
    path: '/v1/memory/search',
    description: 'Search compiled truths by query',
  },
  {
    name: 'memory.list',
    method: 'GET',
    path: '/v1/memory',
    description: 'List compiled truths and timeline entries',
  },
  {
    name: 'memory.extract',
    method: 'POST',
    path: '/v1/memory/extract',
    description: 'Extract MemCell from conversation turn',
  },
  {
    name: 'provider.list',
    method: 'GET',
    path: '/v1/providers',
    description: 'List configured model providers',
  },
  {
    name: 'flow.metrics',
    method: 'GET',
    path: '/v1/flow/metrics',
    description: 'Get latest flow metrics (challenge ratio, degradation)',
  },
  {
    name: 'session.create',
    method: 'POST',
    path: '/v1/sessions',
    description: 'Create new conversation session',
  },
  {
    name: 'session.list',
    method: 'GET',
    path: '/v1/sessions',
    description: 'List all sessions (newest first)',
  },
  {
    name: 'session.get',
    method: 'GET',
    path: '/v1/sessions/:id',
    description: 'Get session by ID with metadata',
  },
  {
    name: 'session.messages',
    method: 'GET',
    path: '/v1/sessions/:id/messages',
    description: 'Get messages for a session',
  },
] as const;

export interface OperationMap {
  readonly 'health': { request: void; response: HealthResponse };
  readonly 'chat': { request: ChatRequest; response: ChatResponse };
  readonly 'chat.stream': { request: ChatRequest; response: ChatStreamChunk };
  readonly 'memory.search': { request: MemorySearchRequest; response: MemorySearchResponse };
  readonly 'memory.list': { request: void; response: MemoryListResponse };
  readonly 'memory.extract': { request: { sessionId: string; messages: readonly { role: string; content: string }[] }; response: { memCellId: string; written: boolean; latencyMs: number } };
  readonly 'provider.list': { request: void; response: { providers: readonly ProviderConfig[] } };
  readonly 'flow.metrics': { request: void; response: FlowMetrics };
  readonly 'session.create': { request: { name?: string }; response: Session };
  readonly 'session.list': { request: void; response: SessionListResponse };
  readonly 'session.get': { request: { id: string }; response: Session };
  readonly 'session.messages': { request: { id: string; limit?: number }; response: SessionMessagesResponse };
}

export function getOperation(name: string): OperationMeta | undefined {
  return OPERATIONS.find(op => op.name === name);
}

export function buildUrl(basePath: string, operation: OperationMeta, params?: Record<string, string>): string {
  let path = operation.path;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(value));
    }
  }
  return `${basePath}${path}`;
}
