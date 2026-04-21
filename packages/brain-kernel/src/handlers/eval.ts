import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { listEvalResults, runAllEvals, runSingleEval } from '../eval/eval-runner.js';
import { EVAL_TASKS } from '../eval/eval-tasks.js';
import { runCalibration } from '../eval/degradation-calibrator.js';
import { jsonResponse, parseJson, validateBody } from './_shared.js';

const EvalRunSchema = z.object({
  taskId: z.string().min(1).optional(),
  tier: z.enum(['baseline', 'memory', 'full']),
});

// 模块级并发锁：同一时间只允许一个评测任务
let evalInFlight = false;

async function handleEvalRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await parseJson<unknown>(req);
  const body = validateBody(EvalRunSchema, raw, res);
  if (!body) return;

  // 并发锁：同一时间只允许一个评测任务
  if (evalInFlight) {
    jsonResponse(res, 429, { error: 'Eval already in progress, please wait' });
    return;
  }

  evalInFlight = true;
  try {
    if (body.taskId) {
      const result = await runSingleEval(body.taskId, body.tier);
      jsonResponse(res, 200, result);
    } else {
      const results = await runAllEvals(body.tier);
      jsonResponse(res, 200, { results, count: results.length });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Eval failed';
    jsonResponse(res, 500, { error: msg });
  } finally {
    evalInFlight = false;
  }
}

function handleEvalResults(_req: IncomingMessage, res: ServerResponse): void {
  const results = listEvalResults(50).map(({ response: _response, ...rest }) => rest);
  const tasks = EVAL_TASKS.map(t => ({ taskId: t.taskId, description: t.description, category: t.category }));
  jsonResponse(res, 200, { results, tasks });
}

function handleDegradationReport(_req: IncomingMessage, res: ServerResponse): void {
  const report = runCalibration();
  jsonResponse(res, 200, report);
}

export async function handleEval(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/v1/eval/run' && method === 'POST') {
    await handleEvalRun(req, res);
    return true;
  }
  if (url === '/v1/eval/results' && method === 'GET') {
    handleEvalResults(req, res);
    return true;
  }
  if (url === '/v1/eval/degradation-report' && method === 'GET') {
    handleDegradationReport(req, res);
    return true;
  }
  return false;
}
