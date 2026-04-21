import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATIONS } from '@evodesk/shared/operations';
import { initDb } from './memory/memory-db.js';
import { startEpisodicSweeper } from './memory/episodic-sweeper.js';
import { getLlmConfig } from './memory/memcell-extractor.js';
import { initFlowStateTable } from './flow/flow-state.js';
import { initEvalTable } from './eval/eval-runner.js';
import {
  handleChat,
  handleEval,
  handleFlow,
  handleMemory,
  handleProviders,
  handleRouter,
} from './handlers/index.js';
import {
  API_KEY,
  authenticate,
  BIND_HOST,
  IS_DEV,
  jsonResponse,
  PORT,
  setCorsHeaders,
  VERSION,
} from './handlers/_shared.js';

const DATA_DIR = process.env.EVODESK_DATA_DIR ?? join(process.cwd(), 'data');

if (!IS_DEV && !API_KEY) {
  console.error('[EvoDesk Brain Kernel] FATAL: EVODESK_API_KEY is required in production (NODE_ENV=production)');
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });
initDb(join(DATA_DIR, 'evodesk.db'));
const episodicSweeper = startEpisodicSweeper();
initFlowStateTable();
initEvalTable();
console.log(`[EvoDesk Brain Kernel] DB initialized at ${DATA_DIR}/evodesk.db`);
console.log(
  `[EvoDesk Brain Kernel] M16 episodic sweeper started (interval=${episodicSweeper.intervalMs}ms, sla=${episodicSweeper.slaMs}ms)`,
);

// ============================================================
// Handler 调度
// ============================================================

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
) => Promise<boolean>;

const handlers: readonly Handler[] = [
  handleProviders,
  handleRouter,
  handleChat,
  handleMemory,
  handleFlow,
  handleEval,
];

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<void> {
  for (const h of handlers) {
    if (await h(req, res, url, method)) return;
  }
  jsonResponse(res, 404, { error: 'Not found' });
}

// ============================================================
// HTTP Server
// ============================================================

const server = createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (url !== '/health' && !authenticate(req, res)) return;

  try {
    await dispatch(req, res, url, method);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error(`[EvoDesk Brain Kernel] ${method} ${url} error:`, err);
    if (message === 'Request body too large') {
      jsonResponse(res, 413, { error: 'Request body too large (max 1MB)' });
    } else if (err instanceof SyntaxError) {
      jsonResponse(res, 400, { error: 'Invalid JSON payload' });
    } else {
      jsonResponse(res, 500, { error: IS_DEV ? message : 'Internal server error' });
    }
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`[EvoDesk Brain Kernel] v${VERSION} listening on ${BIND_HOST}:${PORT}`);
  console.log(`[EvoDesk Brain Kernel] ${OPERATIONS.length} operations registered`);
  const llm = getLlmConfig();
  console.log(`[EvoDesk Brain Kernel] LLM: ${llm ? `${llm.model} @ ${llm.baseUrl}` : 'not configured'}`);
});
