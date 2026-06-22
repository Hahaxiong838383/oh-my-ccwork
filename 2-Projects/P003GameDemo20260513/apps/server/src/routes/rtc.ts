import { Hono } from 'hono';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { verifyAuthToken } from '../auth-jwt.js';
import { profileStore, needsOnboarding } from '../profile-store.js';
import { armFeedback } from '../feedback-arm.js';
import { setPromptOverride, clearPromptOverride } from '../rtc-prompt-override.js';

/**
 * 火山 RTC 实时对话接入（docs/35 Block A）。
 *
 * 手机端小可 app（WebView + 火山 RTC Web SDK）调本路由拿 RTC token + 起 AI agent。
 * 与 demo（Server/scenes/Custom.json 把 AK/SK + ASR/TTS 凭证下发前端）不同：
 *   **凭证全在 server 端组装、不下发前端**，前端只拿到 { appId, roomId, userId, token }。
 *
 * 链路：前端进房 → 火山 RTC 起 AI（豆包 ASR + TTS 小可音色 + CustomLLM 回调我们 /v1 小可大脑）→ 全双工。
 */
const require = createRequire(import.meta.url);
// 火山 RTC token 私有格式（二进制 HMAC），原样复用 demo 的 token.js（不移植避免 bug）。
const { AccessToken, privileges } = require('../rtc-token.cjs') as {
  AccessToken: new (appId: string, appKey: string, roomId: string, userId: string) => {
    addPrivilege: (priv: number, expireTs: number) => void;
    expireTime: (ts: number) => void;
    serialize: () => string;
  };
  privileges: { PrivPublishStream: number; PrivSubscribeStream: number };
};
// @volcengine/openapi 是 CJS，用 require 避免 ESM interop 问题。
const { Signer } = require('@volcengine/openapi') as {
  Signer: new (req: Record<string, unknown>, service: string) => {
    addAuthorization: (cred: { accessKeyId: string; secretKey: string }) => void;
  };
};

const rtcRoute = new Hono();

const RTC_HOST = 'rtc.volcengineapi.com';
const RTC_REGION = 'cn-north-1';
const RTC_VERSION = '2024-12-01';
// 火山 CustomLLM 回调地址：必须公网 HTTPS（火山云回调我们的小可大脑端点）。
const CUSTOM_LLM_URL =
  process.env.CUSTOM_LLM_URL || 'https://kidshub-ai.hahaxiong.cc/v1/chat/completions';
const WELCOME = process.env.RTC_WELCOME_MESSAGE || '指挥官，你回来啦！方舟一直在等你，我们继续探险吧！';
// onboarding 开场白（docs/36）：第一次见面、还没认全孩子时用——先自我介绍 + 问名字。
const ONBOARDING_WELCOME =
  process.env.RTC_ONBOARDING_WELCOME ||
  '你好呀！我是方舟上的小可～我们好像是第一次见面吧？我还不知道该怎么称呼你呢，可以告诉我你叫什么名字吗？';

/** 拼 custom-llm 回调 URL：?session=roomId（工作台 prompt override 取用键）+ 可选 ?token=（记忆注入）。两者可并存。 */
function buildCustomLlmUrl(roomId: string, llmToken?: string): string {
  const params = new URLSearchParams();
  params.set('session', roomId);
  if (llmToken) params.set('token', llmToken);
  return `${CUSTOM_LLM_URL}?${params.toString()}`;
}

/** server 端组装 StartVoiceChat 的 VoiceChat 配置（凭证从 env，不下发前端）。 */
function buildVoiceChatConfig(roomId: string, userId: string, llmToken?: string, welcomeMessage?: string): Record<string, unknown> {
  return {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: roomId, // 一房一任务（火山要求 TaskId 非空）
    AgentConfig: {
      TargetUserId: [userId],
      WelcomeMessage: welcomeMessage || WELCOME,
      UserId: 'xiaoke_bot', // ★ 必须 ASCII，中文报 invalid UserID
      EnableConversationStateCallback: true,
    },
    Config: {
      ASRConfig: {
        Provider: 'volcano',
        ProviderParams: {
          Mode: 'bigmodel',
          AppId: process.env.VOLC_ASR_APP_ID,
          AccessToken: process.env.VOLC_ASR_ACCESS_TOKEN,
          ApiResourceId: process.env.VOLC_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration',
        },
      },
      TTSConfig: {
        Provider: 'volcano_bidirection',
        ProviderParams: {
          app: {
            appid: process.env.VOLC_TTS_APP_ID,
            token: process.env.VOLC_TTS_ACCESS_TOKEN,
            cluster: process.env.VOLC_TTS_CLUSTER || 'volcano_tts',
          },
          audio: {
            voice_type: process.env.VOLC_TTS_VOICE_TYPE,
            speech_rate: 0,
            pitch_rate: 0,
            // 音量（loudness_ratio 0.5-2.0，默认 1.0）——川哥反馈过响，降到 0.6（叠加客户端 setPlaybackVolume 再降）
            loudness_ratio: Number(process.env.VOLC_TTS_LOUDNESS || '0.6'),
          },
          ResourceId: process.env.VOLC_TTS_RESOURCE_ID || 'volc.service_type.10029',
        },
      },
      LLMConfig: {
        Mode: 'CustomLLM',
        // session=roomId → custom-llm 取工作台 prompt override（双模式）；token → 注入记忆。两者可并存。
        Url: buildCustomLlmUrl(roomId, llmToken),
        ModelName: 'xiaoke',
        APIKey: process.env.CUSTOM_LLM_API_KEY || 'none',
        SystemMessages: [],
      },
      InterruptMode: 0, // 0=可打断（全双工 barge-in）
    },
  };
}

/** 用 AK/SK 签名调火山 RTC OpenAPI（StartVoiceChat / StopVoiceChat）。 */
async function callRtcOpenAPI(action: string, body: Record<string, unknown>): Promise<any> {
  const reqData = {
    region: RTC_REGION,
    method: 'POST',
    params: { Action: action, Version: RTC_VERSION },
    headers: { Host: RTC_HOST, 'Content-Type': 'application/json' },
    body,
  };
  const signer = new Signer(reqData, 'rtc');
  signer.addAuthorization({
    accessKeyId: process.env.VOLC_ACCESS_KEY_ID || '',
    secretKey: process.env.VOLC_SECRET_ACCESS_KEY || '',
  });
  const res = await fetch(`https://${RTC_HOST}?Action=${action}&Version=${RTC_VERSION}`, {
    method: 'POST',
    headers: reqData.headers as Record<string, string>,
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * 起一局小可实时语音：生成 RTC token + 起 AI agent。
 * 返回前端进房所需（凭证不含）：{ appId, roomId, userId, token, taskId }。
 */
rtcRoute.post('/start', async (c) => {
  const appId = process.env.VOLC_RTC_APP_ID;
  const appKey = process.env.VOLC_RTC_APP_KEY;
  if (!appId || !appKey) {
    return c.json({ ok: false, error: 'RTC 未配置（VOLC_RTC_APP_ID/KEY）' }, 500);
  }
  if (!process.env.VOLC_ACCESS_KEY_ID || !process.env.VOLC_SECRET_ACCESS_KEY) {
    return c.json({ ok: false, error: 'OpenAPI AK/SK 未配置' }, 500);
  }

  const roomId = `xiaoke-${randomUUID()}`;
  const userId = `user-${randomUUID().slice(0, 8)}`;

  // 工作台「实时对话」双模式：body 带 systemPrompt → 存 prompt override（custom-llm 按 roomId 取用，绕开火山中途换 prompt）。
  const startBody = (await c.req.json().catch(() => ({}))) as { systemPrompt?: string };
  if (startBody.systemPrompt?.trim()) {
    setPromptOverride(roomId, startBody.systemPrompt);
    console.log(`[rtc] prompt override set room=${roomId} (${startBody.systemPrompt.length} 字符)`);
  }

  // RTC token（订阅 + 发布权限，24h 过期）
  const key = new AccessToken(appId, appKey, roomId, userId);
  key.addPrivilege(privileges.PrivSubscribeStream, 0);
  key.addPrivilege(privileges.PrivPublishStream, 0);
  key.expireTime(Math.floor(Date.now() / 1000) + 24 * 3600);
  const token = key.serialize();

  // 登录 token（前端 Authorization）→ 透传给 CustomLLM 端点，让小可记得这个孩子
  const authHeader = c.req.header('authorization') || '';
  const llmToken = /^Bearer\s+(.+)$/i.exec(authHeader.trim())?.[1]?.trim();
  // docs/36 onboarding：还没认全孩子时，火山进房即主动问名字。
  let welcomeMessage: string | undefined;
  if (llmToken) {
    const auth = await verifyAuthToken(llmToken);
    if (auth && needsOnboarding(profileStore.getProfile(auth.accountId))) welcomeMessage = ONBOARDING_WELCOME;
  }
  // 起 AI agent（火山起 task，AI 回调我们 /v1 小可大脑）
  const result = await callRtcOpenAPI('StartVoiceChat', buildVoiceChatConfig(roomId, userId, llmToken, welcomeMessage));
  const err = result?.ResponseMetadata?.Error;
  if (err) {
    console.log(`[rtc] StartVoiceChat failed: ${err.Code} ${err.Message}`);
    return c.json({ ok: false, error: `${err.Code}: ${err.Message}` }, 502);
  }

  console.log(`[rtc] started room=${roomId} user=${userId}`);
  return c.json({ ok: true, appId, roomId, userId, token, taskId: roomId });
});

/** 停止本局（前端离房时调）。 */
rtcRoute.post('/stop', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string; taskId?: string };
  const roomId = body.roomId;
  const taskId = body.taskId || roomId;
  if (!roomId) return c.json({ ok: false, error: 'roomId 必填' }, 400);
  clearPromptOverride(roomId); // 释放工作台 prompt override（双模式）
  const result = await callRtcOpenAPI('StopVoiceChat', {
    AppId: process.env.VOLC_RTC_APP_ID,
    RoomId: roomId,
    TaskId: taskId,
  });
  return c.json({ ok: true, result });
});

/**
 * 吐槽预置（docs/37）：前端点「我要吐槽」→ 标记该登录孩子下一轮走吐槽（custom-llm 回调时落反馈库 + 吐槽人格回应）。
 * RTC 全双工无端侧 captureMode 下发通道，改用 arm（feedback-arm 内存 Map + TTL），custom-llm 一次性消费。
 * 必须登录（token→accountId）；匿名不支持吐槽（落库要 accountId 归属）。
 */
rtcRoute.post('/feedback-arm', async (c) => {
  const authHeader = c.req.header('authorization') || '';
  const llmToken = /^Bearer\s+(.+)$/i.exec(authHeader.trim())?.[1]?.trim();
  const auth = llmToken ? await verifyAuthToken(llmToken) : null;
  if (!auth) return c.json({ ok: false, error: '未登录，吐槽需要登录身份' }, 401);
  armFeedback(auth.accountId);
  console.log(`[rtc] feedback armed account=${auth.accountId}`);
  return c.json({ ok: true });
});

/**
 * 工作台「实时对话」改 prompt 热更新：不重连，更新该房间 override，下一轮 custom-llm 回调即用新 prompt。
 */
rtcRoute.post('/update-prompt', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { roomId?: string; systemPrompt?: string };
  if (!body.roomId || !body.systemPrompt?.trim()) {
    return c.json({ ok: false, error: 'roomId + systemPrompt 必填' }, 400);
  }
  setPromptOverride(body.roomId, body.systemPrompt);
  console.log(`[rtc] prompt override updated room=${body.roomId} (${body.systemPrompt.length} 字符)`);
  return c.json({ ok: true });
});

export { rtcRoute };
