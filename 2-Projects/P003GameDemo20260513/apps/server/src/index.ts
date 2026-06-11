import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { VoicePipeline, type ClientMessage } from './pipeline.js';
import { authRoute } from './routes/auth.js';
import { visionRoute } from './routes/vision.js';

const app = new Hono();
const port = Number(process.env.PORT ?? 8787);

app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/api/auth', authRoute);
app.route('/api/vision', visionRoute);

const server = serve(
  {
    fetch: app.fetch,
    port,
    // 显式 IPv4：node22 下默认监听 '::' 在 macOS 上不接受 127.0.0.1，
    // vite proxy(localhost→IPv4) 会 connection refused
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`[server] listening on http://${info.address}:${info.port}`);
    logProviderStatus();
  },
);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (reqUrl.pathname !== '/ws/voice') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const pipeline = new VoicePipeline(ws);

  ws.on('message', (data, isBinary) => {
    const msg = decodeClientMessage(data, isBinary);
    if (!msg) {
      sendWsError(ws, 'BAD_MESSAGE', '消息格式错误');
      return;
    }
    pipeline.handleClientMessage(msg);
  });

  ws.on('close', () => {
    pipeline.close();
  });

  ws.on('error', () => {
    pipeline.close();
  });
});

function decodeClientMessage(data: RawData, isBinary: boolean): ClientMessage | null {
  if (isBinary) {
    const buf = toBuffer(data);
    if (buf.length === 0) return null;
    const ab = Uint8Array.from(buf).buffer;
    return { type: 'audio.chunk', pcm16: ab };
  }

  const text = toBuffer(data).toString('utf8').trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;

  switch (rec.type) {
    case 'session.start': {
      const sampleRate = Number(rec.sampleRate);
      if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
      return { type: 'session.start', sampleRate };
    }
    case 'audio.end':
      return { type: 'audio.end' };
    case 'barge.in':
      return { type: 'barge.in' };
    case 'tts.say': {
      const text = typeof rec.text === 'string' ? rec.text : '';
      if (!text.trim()) return null;
      return { type: 'tts.say', text };
    }
    case 'session.config': {
      const systemPrompt = typeof rec.systemPrompt === 'string' ? rec.systemPrompt : '';
      if (!systemPrompt.trim() || systemPrompt.length > 32000) return null;
      return { type: 'session.config', systemPrompt };
    }
    case 'chat.trigger': {
      const text = typeof rec.text === 'string' ? rec.text : '';
      if (!text.trim() || text.length > 2000) return null;
      return { type: 'chat.trigger', text };
    }
    default:
      return null;
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function sendWsError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'error', code, message }));
}

function logProviderStatus(): void {
  const asrOk = Boolean(
    process.env.VOLC_ASR_APP_ID &&
      process.env.VOLC_ASR_ACCESS_TOKEN &&
      process.env.VOLC_ASR_RESOURCE_ID &&
      process.env.VOLC_ASR_WS_URL,
  );

  const llmOk = Boolean(
    process.env.GEMINI_PROXY_URL && process.env.GEMINI_API_KEY && process.env.GEMINI_DEFAULT_MODEL,
  );

  const ttsOk = Boolean(
    process.env.VOLC_API_KEY &&
      process.env.VOLC_TTS_RESOURCE_ID &&
      process.env.VOLC_TTS_VOICE_TYPE &&
      process.env.VOLC_TTS_WS_URL,
  );

  console.log(`[server] ASR: ${asrOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] LLM: ${llmOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] TTS: ${ttsOk ? 'ready' : 'missing-env'}`);
}
