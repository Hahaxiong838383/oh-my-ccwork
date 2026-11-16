import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CcClient, CcHttpError } from './cc-client';
import type { ServerConfig } from './config';
import { log } from './logger';

function writeJson(response: ServerResponse, status: number, body: unknown, requestId: string, retryAfterSeconds?: number) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
  };
  if (retryAfterSeconds !== undefined) headers['Retry-After'] = String(retryAfterSeconds);
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

export function createBffHandler(config: ServerConfig, cc = new CcClient(config)) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const suppliedRequestId = request.headers['x-request-id'];
    const requestId = typeof suppliedRequestId === 'string' && suppliedRequestId.length <= 96 ? suppliedRequestId : randomUUID();
    if (request.method === 'GET' && request.url === '/health') {
      writeJson(response, 200, { ok: true, service: config.serviceName, version: config.serviceVersion }, requestId);
      return;
    }
    const probe = request.url?.match(/^\/dev\/probe\/(success|empty|unauthorized|rate-limited)$/);
    if (request.method === 'GET' && probe && process.env.NODE_ENV !== 'production') {
      try {
        const body = await cc.request({
          path: `/scenario/${probe[1]}`,
          parentJwt: 'local-development-token',
          userIp: request.socket.remoteAddress || '127.0.0.1',
          requestId,
        });
        writeJson(response, 200, body, requestId);
      } catch (error) {
        if (error instanceof CcHttpError) writeJson(response, error.status, error.payload, requestId, error.retryAfterSeconds);
        else {
          log('error', 'upstream_request_failed', { requestId, error: error instanceof Error ? error.message : 'unknown' });
          writeJson(response, 502, { ok: false, error: 'upstream_unavailable' }, requestId);
        }
      }
      return;
    }
    writeJson(response, 404, { ok: false, error: 'not_found' }, requestId);
  };
}
