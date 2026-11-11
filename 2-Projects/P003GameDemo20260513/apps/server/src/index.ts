import {arkRoute} from './routes/ark.js';
import {arkFactsRoute} from './ark/proxy.js';
import {arkService} from './ark/service.js';
import { serve } from '@hono/node-server';
import {getConnInfo} from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { VoicePipeline, type ClientMessage, type SessionMeta } from './pipeline.js';
import { authRoute } from './routes/auth.js';
import { inviteAuthRoute } from './routes/invite-auth.js';
import { smsAuthRoute } from './routes/sms-auth.js';
import { wechatAuthRoute } from './routes/wechat-auth.js';
import { bleBindingsRoute } from './routes/ble-bindings.js';
import { deviceEnrollmentRoute, deviceProvisioningRoute } from './routes/device-enrollments.js';
import { getBleBindingStore } from './ble-binding-store.js';
import { feedbackRoute } from './routes/feedback.js';
import { conversationRoute } from './routes/conversation.js';
import { visionRoute } from './routes/vision.js';
import { profileRoute } from './routes/profile.js';
import { memoryRoute } from './routes/memory.js';
import { adminDataRoute } from './routes/admin-data.js';
import { startPersonaDailyTimer } from './insight-runner.js';
import { customLlmRoute } from './routes/custom-llm.js';
import { rtcRoute } from './routes/rtc.js';
import { deviceSessionRoute } from './routes/device-session.js';
import { otaDeviceRoute } from './routes/ota.js';
import { pckDeviceRoute } from './routes/ota-pck.js';
import { deviceConfigRoute } from './routes/device-config.js';
import { localAudioDeviceRoute } from './routes/local-audio.js';
import { parentPairingRoute, devicePairingRoute } from './routes/pairing.js';
import { deviceTelemetryRoute, parentTelemetryRoute } from './routes/telemetry.js';
import { diagnosticsDeviceRoute } from './routes/diagnostics.js';
import { devItemsRoute } from './routes/dev-items.js';
import { themesRoute } from './routes/themes.js';
import { checkAndCount, getClientIp } from './guard.js';
import { verifyAuthToken, type AuthContext } from './auth-jwt.js';
import { searchTaskRoute } from './tools/search-runtime.js';
import { searchAdminRoute } from './routes/search-admin.js';
import { createListeningRoute,createLazyListeningRoute } from './routes/listening.js';
import { getListeningAuthority } from './listening-runtime.js';
import { generateListeningContent,readListeningPersonality } from './listening-content.js';

const app = new Hono();
// Additive schema is checked at startup; no device is automatically enrolled in BLE identity policy.
getBleBindingStore();
const port = Number(process.env.PORT ?? 8787);

app.get('/health', (c) => c.json({ status: 'ok' }));
app.use('/internal/ark-facts',async(c,next)=>{if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(getConnInfo(c).remote.address??''))return c.json({ok:false},404);await next();});
app.route('/internal/ark-facts',arkFactsRoute({secret:()=>process.env.ARK_FACTS_PROXY_SECRET??'',allowed:()=> (process.env.ARK_FACTS_PROXY_SN_ALLOW??'').split(',').filter(Boolean),facts:sn=>arkService().preview(sn)}));
app.route('/api/auth', authRoute);
app.route('/api/auth', inviteAuthRoute);
app.route('/api/auth', smsAuthRoute);
app.route('/api/auth', wechatAuthRoute);
app.route('/api/feedback', feedbackRoute);
app.route('/api/conversation', conversationRoute);
app.route('/api/vision', visionRoute);
app.route('/api/profile', profileRoute);
app.route('/api/memory', memoryRoute);
app.route('/api/admin', adminDataRoute);
app.route('/api/admin/search', searchAdminRoute);
app.route('/api/rtc', rtcRoute);
app.route('/api/dev-items', devItemsRoute);
app.route('/api/feedback-themes', themesRoute);
// P003 S2-B1 设备 Session API（安卓/MCU 设备换 LiveKit token；docs/CC_S2B1_MCU_SN_TOKEN_SESSION_API_PROMPT_20260815）。
app.route('/v1/device', deviceSessionRoute);
app.route('/v1/device/ark', arkRoute);
app.route('/v1/device/ota', otaDeviceRoute);
app.route('/v1/device/ota/content', pckDeviceRoute); // PCK 文件接口（双 OTA 合同 §6）
app.route('/v1/device/config', deviceConfigRoute);
// 本地人格音频（合同 CODEX_P003_LOCAL_AUDIO_CONTRACT_v1.1）：manifest + 音频文件分发
app.route('/v1/device/local-audio', localAudioDeviceRoute);
app.route('/v1/device/pairing', devicePairingRoute);
// 设备遥测上报 + 家长聚合查询（合同 CODEX_P003_DEVICE_TELEMETRY_REPLY_20260824）
app.route('/v1/device/telemetry', deviceTelemetryRoute);
app.route('/v1/parent/devices', parentTelemetryRoute);
// 设备诊断日志上云（Godot→Launcher→server；合同 DIAGNOSTIC_LOG_SERVER_HANDOFF + CC 复核回执 §3；路径字面冒号 logs:batch）
app.route('/v1/device/diagnostics', diagnosticsDeviceRoute);
// 配网家长侧（联调合同 v3）：token 签发 + H5 轮询
app.route('/api/parent/pairing', parentPairingRoute);
app.route('/api/parent/ble-bindings', bleBindingsRoute);
app.route('/api/parent/device-enrollments', deviceEnrollmentRoute);
app.route('/v1/device/provisioning', deviceProvisioningRoute);
// 火山 RTC 实时对话 CustomLLM 回调端点（docs/34 D 方案）：OpenAI 兼容 /v1/chat/completions（SSE）。
app.route('/v1', customLlmRoute);
// Default-off independent background jobs; ordinary chat never awaits these requests.
app.route('/v1/internal/search-tasks', searchTaskRoute);
app.route('/v1/internal/listening', createLazyListeningRoute(()=>createListeningRoute(getListeningAuthority(), {generate:generateListeningContent,personality:readListeningPersonality})));

// admin 静态兜底（本地 dev 同源 E2E 用；生产 nginx 直接 serve public/admin，不会走到这里）。
app.use('/admin/*', serveStatic({ root: '../web/public' }));
app.get('/admin', (c) => c.redirect('/admin/'));

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
    startPersonaDailyTimer(); // M3/M6 每日批(沪时 3 点档,人格成长方案)
  },
);

const wss = new WebSocketServer({ noServer: true });

// Step 4：WS 握手鉴权产物（accountId）按连接关联，不改 emit/on 签名（向后兼容）
const wsAuth = new WeakMap<WebSocket, AuthContext>();

server.on('upgrade', (req, socket, head) => {
  void (async () => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (reqUrl.pathname !== '/ws/voice') {
        socket.destroy();
        return;
      }

      // 可选 wsToken：有 token 解析身份，无 token / 无效 → 退回现有匿名行为（向后兼容）
      const auth = await verifyAuthToken(reqUrl.searchParams.get('token'));

      wss.handleUpgrade(req, socket, head, (ws) => {
        if (auth) wsAuth.set(ws, auth);
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  })();
});

wss.on('connection', (ws, req) => {
  // 连接时立即做 ws_session 限额检查（使用共享 getClientIp）
  const clientIp = getClientIp(req);
  const sessCheck = checkAndCount('ws_session', clientIp);
  if (!sessCheck.ok) {
    sendWsError(ws, 'RATE_LIMITED', '今日体验次数已达上限，明天再来玩吧');
    ws.close();
    return;
  }

  const auth = wsAuth.get(ws) ?? null;
  const pipeline = new VoicePipeline(ws, clientIp, auth);
  // 连接生命周期日志：公网排障用（客户端"没反应"时分辨 ws 是否到达 server、活了多久、传了什么）
  const openedAt = Date.now();
  let msgCount = 0;
  console.log(`[ws] open ip=${clientIp}`);

  ws.on('message', (data, isBinary) => {
    msgCount += 1;
    const msg = decodeClientMessage(data, isBinary);
    if (!msg) {
      sendWsError(ws, 'BAD_MESSAGE', '消息格式错误');
      return;
    }

    // chat_round 限额：仅对会触发 LLM 的消息类型检查（chat.trigger / audio.end）
    // 超限仅发错误码不断开连接
    if (msg.type === 'chat.trigger' || msg.type === 'audio.end') {
      const roundCheck = checkAndCount('chat_round', clientIp);
      if (!roundCheck.ok) {
        sendWsError(ws, 'RATE_LIMITED', '今日体验次数已达上限，明天再来玩吧');
        return;
      }
    }

    pipeline.handleClientMessage(msg);
  });

  ws.on('close', (code) => {
    console.log(`[ws] close ip=${clientIp} code=${code} lived=${Math.round((Date.now() - openedAt) / 1000)}s msgs=${msgCount}`);
    pipeline.close();
  });

  ws.on('error', (err) => {
    console.log(`[ws] error ip=${clientIp} ${String((err as Error)?.message ?? err)}`);
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
    case 'session.meta': {
      const meta = parseSessionMeta(rec);
      return meta ? { type: 'session.meta', meta } : null;
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

function parseSessionMeta(rec: Record<string, unknown>): SessionMeta | null {
  const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId.trim() : '';
  if (!sessionId) return null;

  const sceneIdValue = rec.sceneId;
  if (sceneIdValue !== null && typeof sceneIdValue !== 'string') return null;
  const sceneId = typeof sceneIdValue === 'string' && sceneIdValue.trim() ? sceneIdValue.trim() : null;

  const nickname = typeof rec.nickname === 'string' ? rec.nickname : '';
  const gender = typeof rec.gender === 'string' ? rec.gender : '';
  const age = typeof rec.age === 'string' ? rec.age : '';
  const tutorialUnitId =
    typeof rec.tutorialUnitId === 'string' && rec.tutorialUnitId.trim() ? rec.tutorialUnitId.trim() : undefined;
  const source = rec.source === 'card' || rec.source === 'tutorial' ? rec.source : null;
  if (!source) return null;

  const captureMode = rec.captureMode === 'feedback' || rec.captureMode === 'off' ? rec.captureMode : 'off';
  return {
    sessionId,
    sceneId,
    nickname,
    gender,
    age,
    tutorialUnitId,
    captureMode,
    source,
  };
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

  // LLM ready 判断按 provider 分支：
  // deepseek 只检查 DEEPSEEK_API_KEY（BASE_URL/MODEL 有默认值）
  // gemini 维持原有三个必填判断（公司侧部署零影响）
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  let llmOk = false;
  if (provider === 'deepseek') {
    llmOk = Boolean(process.env.DEEPSEEK_API_KEY);
  } else if (provider === 'minimax') {
    llmOk = Boolean(process.env.MINIMAX_API_KEY);
  } else {
    llmOk = Boolean(
      process.env.GEMINI_PROXY_URL && process.env.GEMINI_API_KEY && process.env.GEMINI_DEFAULT_MODEL,
    );
  }

  const ttsOk = Boolean(
    process.env.VOLC_API_KEY &&
      process.env.VOLC_TTS_RESOURCE_ID &&
      process.env.VOLC_TTS_VOICE_TYPE &&
      process.env.VOLC_TTS_WS_URL,
  );

  console.log(`[server] LLM provider: ${provider}`);
  console.log(`[server] ASR: ${asrOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] LLM: ${llmOk ? 'ready' : 'missing-env'}`);
  console.log(`[server] TTS: ${ttsOk ? 'ready' : 'missing-env'}`);
}
