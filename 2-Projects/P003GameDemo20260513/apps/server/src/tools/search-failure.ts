/** Stable, deliberately small diagnostics. Never retain a raw error, URL or body. */
export type SearchStage = 'search' | 'answer' | 'tools' | 'fetch' | 'weather' | 'task';
export type SearchFailureInfo = {
  stage: SearchStage;
  reason: 'transport' | 'timeout' | 'aborted' | 'http' | 'invalid_json' | 'invalid_response' |
    'invalid_stream' | 'invalid_answer' | 'invalid_result' | 'unasked_quantity' | 'configuration' | 'unknown';
  status_code?: number;
};
export class SearchFailure extends Error {
  constructor(message: string, readonly failure: SearchFailureInfo) { super(message); }
}

export function searchFailure(error: unknown, stage: SearchStage = 'task'): SearchFailure {
  if (error instanceof SearchFailure) return error;
  const message = error instanceof Error ? error.message : '';
  const status = /^upstream_([45]\d\d)$/.exec(message);
  if (status) return new SearchFailure(message, { stage, reason: 'http', status_code: Number(status[1]) });
  const known: Record<string, SearchFailureInfo['reason']> = {
    invalid_search_response: 'invalid_response', empty_response: 'invalid_response', response_too_large: 'invalid_response',
    invalid_fetch: 'invalid_response', invalid_tool_stream: 'invalid_stream', incomplete_tool_stream: 'invalid_stream',
    invalid_answer: 'invalid_answer', invalid_result: 'invalid_result', unasked_quantity: 'unasked_quantity',
    search_unconfigured: 'configuration',
  };
  if (Object.hasOwn(known, message)) {
    if (stage === 'task' && ['invalid_answer', 'unasked_quantity'].includes(message)) stage = 'answer';
    return new SearchFailure(message, { stage, reason: known[message] });
  }
  const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout'
    : error instanceof Error && error.name === 'AbortError' ? 'aborted'
    : error instanceof SyntaxError ? 'invalid_json'
    : error instanceof TypeError && stage !== 'task' ? 'transport' : 'unknown';
  return new SearchFailure(reason === 'aborted' ? 'search_aborted' : `search_${reason}`, { stage, reason });
}

export async function searchStage<T>(stage: SearchStage, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try { return await run(); } catch (error) {
    if (signal?.aborted) {
      const timeout = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      throw new SearchFailure(timeout ? 'search_timeout' : 'search_aborted', {stage, reason: timeout ? 'timeout' : 'aborted'});
    }
    throw searchFailure(error, stage);
  }
}
