#!/usr/bin/env python3
"""
Lightweight Gemini API Proxy (OpenAI-compatible)

Google Gemini natively supports OpenAI format, this proxy:
1. Accepts OpenAI-format requests on port 4000
2. Validates Bearer token
3. Injects Gemini API key
4. Forwards to Google endpoint (including streaming)
"""
import os, asyncio, logging
from aiohttp import web, ClientSession, TCPConnector
from dotenv import load_dotenv

load_dotenv('/opt/gemini-proxy/.env')

GEMINI_KEY = os.environ['GEMINI_API_KEY']
PROXY_TOKEN = os.environ['PROXY_TOKEN']
PROXY_PORT = int(os.environ.get('PROXY_PORT', '4000'))
GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
log = logging.getLogger('proxy')


def check_auth(request):
    auth = request.headers.get('Authorization', '')
    token = auth.replace('Bearer ', '') if auth.startswith('Bearer ') else ''
    if token != PROXY_TOKEN:
        raise web.HTTPUnauthorized(text='Invalid token')


async def health(request):
    return web.json_response({'status': 'ok', 'service': 'gemini-proxy'})


async def list_models(request):
    check_auth(request)
    async with ClientSession() as session:
        url = f'{GOOGLE_BASE}/models'
        headers = {'Authorization': f'Bearer {GEMINI_KEY}'}
        async with session.get(url, headers=headers) as resp:
            body = await resp.read()
            return web.Response(body=body, status=resp.status,
                                content_type=resp.content_type)


async def proxy_handler(request):
    check_auth(request)
    path = request.match_info.get('path', '')
    url = f'{GOOGLE_BASE}/{path}'
    body = await request.read()

    log.info(f'{request.method} /{path} ({len(body)} bytes)')

    fwd_headers = {
        'Authorization': f'Bearer {GEMINI_KEY}',
        'Content-Type': request.headers.get('Content-Type', 'application/json'),
    }

    connector = TCPConnector(ssl=True)
    async with ClientSession(connector=connector) as session:
        async with session.request(
            method=request.method,
            url=url,
            headers=fwd_headers,
            data=body,
        ) as resp:
            ct = resp.headers.get('Content-Type', '')

            # Streaming (SSE)
            if 'text/event-stream' in ct:
                response = web.StreamResponse(
                    status=resp.status,
                    headers={
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                    }
                )
                await response.prepare(request)
                async for chunk in resp.content.iter_any():
                    await response.write(chunk)
                await response.write_eof()
                return response

            # Normal response
            resp_body = await resp.read()
            return web.Response(
                body=resp_body,
                status=resp.status,
                content_type=ct or 'application/json',
            )


app = web.Application(client_max_size=50 * 1024 * 1024)  # 50MB max
app.router.add_get('/health', health)
app.router.add_get('/v1/models', list_models)
app.router.add_route('*', '/v1/{path:.*}', proxy_handler)

if __name__ == '__main__':
    log.info(f'Gemini proxy starting on port {PROXY_PORT}')
    web.run_app(app, host='0.0.0.0', port=PROXY_PORT, print=None)
    log.info('Gemini proxy started')
