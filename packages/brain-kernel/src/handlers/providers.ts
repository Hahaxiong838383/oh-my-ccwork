import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  checkSidecarHealth,
  jsonResponse,
  startTime,
  VERSION,
} from './_shared.js';

async function handleHealthEndpoint(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sidecar = await checkSidecarHealth();
  const response = {
    status: 'ok' as const,
    version: VERSION,
    uptime: Date.now() - startTime,
    sidecar,
  };
  jsonResponse(res, 200, response);
}

function handleProviderListEndpoint(_req: IncomingMessage, res: ServerResponse): void {
  jsonResponse(res, 200, { providers: [] });
}

export async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/health' && method === 'GET') {
    await handleHealthEndpoint(req, res);
    return true;
  }
  if (url === '/v1/providers' && method === 'GET') {
    handleProviderListEndpoint(req, res);
    return true;
  }
  return false;
}
