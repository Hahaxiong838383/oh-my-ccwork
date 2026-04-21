import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { extractMemCell, getLlmConfig } from '../memory/memcell-extractor.js';
import { clearBrainContextCache } from '../memory/brain-context.js';
import { hybridSearch, ftsSearch } from '../memory/retrieval.js';
import {
  countMemCells,
  createSession,
  deleteSession,
  deleteTruth,
  getSession,
  getSessionMessages,
  insertMemCell,
  listSessions,
  listTimeline,
  listTruths,
  renameSession,
  updateTruth,
} from '../memory/memory-db.js';
import {
  jsonResponse,
  parseJson,
  readBody,
  validateBody,
} from './_shared.js';

const MAX_FTS_QUERY_LENGTH = 500;

const MemorySearchSchema = z.object({
  query: z.string().min(1).max(MAX_FTS_QUERY_LENGTH),
  limit: z.number().int().min(1).max(100).optional(),
  domain: z.string().optional(),
  mode: z.enum(['fts', 'hybrid']).optional(),
});

const MemoryExtractSchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).min(1),
});

const SessionCreateSchema = z.object({
  name: z.string().max(200).optional(),
});

const SessionRenameSchema = z.object({
  name: z.string().min(1).max(200),
});

const TruthUpdateSchema = z.object({
  statement: z.string().trim().min(1).max(500).optional(),
  domain: z.string().trim().min(1).max(100).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

async function handleMemorySearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await parseJson<unknown>(req);
  const body = validateBody(MemorySearchSchema, raw, res);
  if (!body) return;
  const limit = body.limit ?? 10;
  const mode = body.mode ?? 'hybrid';
  const startMs = Date.now();
  const results = mode === 'fts'
    ? ftsSearch(body.query, limit)
    : hybridSearch(body.query, limit);
  jsonResponse(res, 200, { results, mode, queryTimeMs: Date.now() - startMs });
}

function handleMemoryList(_req: IncomingMessage, res: ServerResponse): void {
  const truths = listTruths(500);
  const timeline = listTimeline(100);
  const totalMemCells = countMemCells();
  jsonResponse(res, 200, { truths, timeline, totalMemCells });
}

async function handleMemoryExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawExtract = await parseJson<unknown>(req);
  const body = validateBody(MemoryExtractSchema, rawExtract, res);
  if (!body) return;

  const llmConfig = getLlmConfig();
  if (!llmConfig) {
    jsonResponse(res, 503, { error: 'LLM not configured (set EVODESK_LLM_BASE_URL/API_KEY/MODEL)' });
    return;
  }

  const { memCell, model, latencyMs } = await extractMemCell(body, llmConfig);
  const { written } = insertMemCell(memCell);
  console.log(`[memory-extract] ${written ? 'stored' : 'duplicate'} memCell=${memCell.id} model=${model} ${latencyMs}ms`);
  jsonResponse(res, 200, { memCellId: memCell.id, written, latencyMs });
}

async function handleSessionCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawStr = await readBody(req);
  const parsed = JSON.parse(rawStr || '{}') as unknown;
  const body = validateBody(SessionCreateSchema, parsed, res);
  if (!body) return;

  const id = crypto.randomUUID();
  const name = body.name?.trim() || '新对话';
  const session = createSession(id, name);
  jsonResponse(res, 200, session);
}

function handleSessionList(_req: IncomingMessage, res: ServerResponse): void {
  const sessions = listSessions();
  jsonResponse(res, 200, { sessions });
}

function handleSessionGet(sessionId: string, res: ServerResponse): void {
  const session = getSession(sessionId);
  if (!session) {
    jsonResponse(res, 404, { error: 'Session not found' });
    return;
  }
  jsonResponse(res, 200, session);
}

function handleSessionMessages(sessionId: string, res: ServerResponse): void {
  const session = getSession(sessionId);
  if (!session) {
    jsonResponse(res, 404, { error: 'Session not found' });
    return;
  }
  const messages = getSessionMessages(sessionId);
  jsonResponse(res, 200, { messages, sessionId });
}

async function handleSessionRename(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    jsonResponse(res, 404, { error: 'Session not found' });
    return;
  }
  const raw = await parseJson<unknown>(req);
  const body = validateBody(SessionRenameSchema, raw, res);
  if (!body) return;
  renameSession(sessionId, body.name);
  jsonResponse(res, 200, { ...session, name: body.name, lastAccessedAt: Date.now() });
}

function handleSessionDelete(sessionId: string, res: ServerResponse): void {
  const session = getSession(sessionId);
  if (!session) {
    jsonResponse(res, 404, { error: 'Session not found' });
    return;
  }
  deleteSession(sessionId);
  jsonResponse(res, 200, { deleted: true });
}

function handleSessionExport(sessionId: string, req: IncomingMessage, res: ServerResponse): void {
  const session = getSession(sessionId);
  if (!session) {
    jsonResponse(res, 404, { error: 'Session not found' });
    return;
  }

  const messages = getSessionMessages(sessionId, 10000);
  const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const format = urlObj.searchParams.get('format') ?? 'markdown';

  if (format === 'json') {
    jsonResponse(res, 200, { session, messages });
    return;
  }

  // Markdown 格式
  const lines: string[] = [
    `# ${session.name}`,
    '',
    `- **Session ID**: ${session.id}`,
    `- **Created**: ${new Date(session.createdAt).toLocaleString()}`,
    `- **Messages**: ${messages.length}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleString();
    const role = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**Assistant**' : '**System**';
    lines.push(`### ${role} — ${time}`, '', msg.content, '', '---', '');
  }

  const markdown = lines.join('\n');
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="session-${sessionId.slice(0, 8)}.md"`,
  });
  res.end(markdown);
}

function handleTruthDelete(truthId: string, res: ServerResponse): void {
  deleteTruth(truthId);
  clearBrainContextCache();
  jsonResponse(res, 200, { deleted: true });
}

async function handleTruthUpdate(
  truthId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await parseJson<unknown>(req);
  const body = validateBody(TruthUpdateSchema, raw, res);
  if (!body) return;

  if (!body.statement && !body.domain && body.confidence === undefined) {
    jsonResponse(res, 400, { error: 'At least one field (statement, domain, confidence) required' });
    return;
  }

  const updated = updateTruth(truthId, body);
  if (!updated) {
    jsonResponse(res, 404, { error: 'Truth not found' });
    return;
  }
  clearBrainContextCache();
  jsonResponse(res, 200, updated);
}

export async function handleMemory(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  // 路径正则匹配
  const sessionMatch = url.match(/^\/v1\/sessions\/([^/]+)$/);
  const sessionMsgMatch = url.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
  const sessionExportMatch = url.match(/^\/v1\/sessions\/([^/]+)\/export(?:\?|$)/);
  const truthMatch = url.match(/^\/v1\/memory\/truths\/([^/]+)$/);

  if (url === '/v1/memory/search' && method === 'POST') {
    await handleMemorySearch(req, res);
    return true;
  }
  if (url === '/v1/memory' && method === 'GET') {
    handleMemoryList(req, res);
    return true;
  }
  if (url === '/v1/memory/extract' && method === 'POST') {
    await handleMemoryExtract(req, res);
    return true;
  }
  if (url === '/v1/sessions' && method === 'POST') {
    await handleSessionCreate(req, res);
    return true;
  }
  if (url === '/v1/sessions' && method === 'GET') {
    handleSessionList(req, res);
    return true;
  }
  if (sessionExportMatch && method === 'GET') {
    handleSessionExport(sessionExportMatch[1], req, res);
    return true;
  }
  if (sessionMsgMatch && method === 'GET') {
    handleSessionMessages(sessionMsgMatch[1], res);
    return true;
  }
  if (sessionMatch && method === 'GET') {
    handleSessionGet(sessionMatch[1], res);
    return true;
  }
  if (sessionMatch && method === 'PUT') {
    await handleSessionRename(sessionMatch[1], req, res);
    return true;
  }
  if (sessionMatch && method === 'DELETE') {
    handleSessionDelete(sessionMatch[1], res);
    return true;
  }
  if (truthMatch && method === 'PUT') {
    await handleTruthUpdate(truthMatch[1], req, res);
    return true;
  }
  if (truthMatch && method === 'DELETE') {
    handleTruthDelete(truthMatch[1], res);
    return true;
  }
  return false;
}
