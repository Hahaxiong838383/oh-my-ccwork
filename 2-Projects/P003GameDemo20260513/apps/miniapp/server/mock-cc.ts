import { createServer } from 'node:http';

const host = process.env.MOCK_CC_HOST || '127.0.0.1';
const port = Number(process.env.MOCK_CC_PORT || 4191);

const server = createServer((request, response) => {
  const requestId = typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : 'missing';
  const common = { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': requestId };
  if (request.method === 'GET' && request.url === '/scenario/success') {
    response.writeHead(200, common);
    response.end(JSON.stringify({ ok: true, source: 'mock_cc' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/scenario/empty') {
    response.writeHead(200, common);
    response.end(JSON.stringify({ items: [], next_cursor: null, has_more: false }));
    return;
  }
  if (request.method === 'GET' && request.url === '/scenario/unauthorized') {
    response.writeHead(401, common);
    response.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/scenario/rate-limited') {
    response.writeHead(429, { ...common, 'Retry-After': '5' });
    response.end(JSON.stringify({ ok: false, error: 'rate_limited', retry_after_s: 5 }));
    return;
  }
  response.writeHead(404, common);
  response.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(port, host, () => console.log(JSON.stringify({ level: 'info', event: 'mock_cc_started', host, port })));
