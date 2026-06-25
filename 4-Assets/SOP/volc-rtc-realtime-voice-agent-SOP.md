# 火山 RTC 实时语音交互 Agent 实施方案（ASR + LLM + TTS 全链路）

> **一句话用途**：给 Claude Code（或任何 AI 编码助手）一份可直接落地的实施蓝图——基于火山引擎 RTC 做全双工实时语音对话 agent，ASR/TTS 用豆包大模型语音，LLM 用「CustomLLM 回调」把大脑留在自己的服务器。文档同时充当**引导人类新手从零开通火山服务**的脚本。
>
> **证据等级**：所有技术字段（endpoint / header / ResourceId / Provider 名 / 配置 schema / 踩坑）均为 **[已验证]**，提炼自 P003「小可」生产代码（`2-Projects/P003GameDemo20260513/`，2026-06 真机 + 公网 E2E 跑通）。涉及火山**控制台开通的精确菜单路径**标 **[需控制台核对]**——产品名是对的，但火山控制台改版频繁，按钮位置以实际为准，不要照本宣科点死。
>
> **维护人**：cc（Claude）｜ 初版 2026-06-25

---

## 0. 给 Claude 的元说明（怎么用这份文档）

当人类说「我想做一个像小可那样能实时语音对话的 AI」时，按这个顺序走：

1. **先讲清架构**（§1）——让人类理解「火山只做语音管道，AI 大脑在你自己服务器」这个核心分工，否则后面所有配置都是黑盒。
2. **引导开通服务 + 收集凭据**（§2）——这是新手最容易卡死的一步。逐项核对 §2.6 的凭据清单，**缺一个都跑不起来**。
3. **按链路实现**（§3 SDK → §4 ASR → §5 TTS → §6 LLM → §7 server 组装 → §8 前端）。
4. **照 §10 踩坑清单逐条预检**——这些都是真金白银踩出来的，能省人类好几天。
5. **用 §11 的方法做端到端验证**，别让人类自己拿手机瞎试。

核心心智模型：**火山 RTC = 「语音 I/O + 编排管道」，你的 server = 「AI 的大脑」**。火山负责采音、ASR 转写、把文本 POST 给你、拿你的回复送 TTS 播出去、回声消除、打断检测；你只负责「收到一段文本 → 流式吐回一段文本」。

---

## 1. 架构总览

### 1.1 数据流（全双工一轮对话）

```
 孩子说话                                                         小可发声
   │  麦克风音频                                                    ▲ TTS 音频
   ▼                                                               │
┌─────────────────────────────┐                      ┌───────────────────────────┐
│  前端（浏览器 / WebView）       │   RTC 音频流(WebRTC)  │     火山引擎 RTC 云         │
│  @volcengine/rtc SDK          │◄────────────────────►│  (AIGC 对话式 AI 编排)      │
│  - joinRoom 进房               │                      │   ┌─────────┐ ┌─────────┐ │
│  - 收二进制消息(状态/字幕)       │                      │   │ 豆包 ASR │ │ 豆包 TTS │ │
└─────────────┬───────────────┘                      │   └────┬────┘ └────▲────┘ │
              │ ① POST /api/rtc/start                  └────────┼──────────┼───────┘
              │   (拿 token+起 AI)                              │ ② ASR文本 │ ④ 回复文本
              ▼                                          OpenAI格式│         │SSE流
┌──────────────────────────────────────────────────────────────┼─────────┼──────┐
│  你的 server（Node/Hono 等）                                     ▼         │      │
│  - POST /api/rtc/start：签名调火山 OpenAPI StartVoiceChat ───────────────►(起task)│
│  - POST /v1/chat/completions：CustomLLM 回调端点 ◄──────────────③─────────┘      │
│       收到 ASR 文本 → 拼 system prompt → 调你的 LLM → SSE 流式吐回                  │
│  - 你的 LLM（Gemini / DeepSeek / 任意 OpenAI 兼容）+ 记忆 + 人设 + 安全护栏         │
└──────────────────────────────────────────────────────────────────────────────┘
```

四个关键交互：
- **① 起会话**：前端 POST 你的 `/api/rtc/start`，server 用 AK/SK 签名调火山 OpenAPI `StartVoiceChat`，火山在云端起一个 AI task，并把 RTC token 返回前端进房。
- **② ASR**：孩子说话 → 火山云调豆包 ASR 转写 → 把文本以 **OpenAI ChatCompletion 格式** POST 到你配置的 CustomLLM Url（③）。
- **③ LLM**：你的 `/v1/chat/completions` 端点收到文本，拼好 system prompt（人设/记忆/护栏），调你自己的 LLM，以 **SSE 流**（`data: {...}` + `data: [DONE]`）返回。
- **④ TTS**：火山把你流式吐回的文本送豆包 TTS 合成，通过 RTC 音频流播给孩子。打断（barge-in）、回声消除（3A）全由火山云侧处理。

### 1.2 为什么用「CustomLLM 回调」而不是让火山托管 LLM

火山也支持直接配一个 LLM（如方舟上的豆包模型），但那样**大脑是黑盒**：换不了模型、注入不了你的记忆系统、加不了自定义安全护栏、改 prompt 要重连。CustomLLM 模式把火山降级为纯语音管道，**LLM / prompt / 记忆 / 护栏 100% 在你手里**，可热更 prompt（不重连），可任意切 LLM（Gemini ↔ DeepSeek ↔ 自托管）。

依据：`apps/server/src/routes/custom-llm.ts:17-29`（端点职责说明）、`apps/server/src/routes/rtc.ts:97-104`（`LLMConfig.Mode='CustomLLM'`）。

---

## 2. 引导新手开通火山服务 + 收集凭据 【关键·最易卡死】

火山引擎一个 agent 要**三套独立的产品 + 凭据**：RTC、ASR、TTS。它们各自有自己的 AppId 和密钥，**不通用**。新手最常见的错误就是把三套凭据搞混。

### 2.1 注册火山引擎账号
- 访问 火山引擎官网 `https://www.volcengine.com`，注册并完成**实名认证**（语音/RTC 产品要求实名）。[需控制台核对]

### 2.2 拿账号级 AK/SK（OpenAPI 签名用，所有 OpenAPI 通用）
- 控制台右上角头像 →「访问控制 / 密钥管理（API 访问密钥）」→ 创建 `AccessKeyId` + `SecretAccessKey`。[需控制台核对]
- 对应代码：`VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`，用于给 `StartVoiceChat`/`StopVoiceChat` 做 V4 签名（`rtc.ts:120-123`）。
- ⚠️ 这是**账号级最高权限密钥**，泄露 = 整个账号沦陷。只存 server 端环境变量，绝不进前端/git。

### 2.3 开通 RTC（实时音视频）
- 控制台 → 产品「**视频云 · 实时音视频 RTC**」→ 创建应用 → 拿到 **AppId** 和 **AppKey（主密钥）**。[需控制台核对]
- 在该应用下开通「**对话式 AI / AIGC**」能力（StartVoiceChat 接口属于这个能力，未开通会报权限错）。[需控制台核对]
- 对应代码：`VOLC_RTC_APP_ID`（前端进房 + OpenAPI 都用）、`VOLC_RTC_APP_KEY`（生成 RTC token 的签名密钥，`rtc.ts:157`）。

### 2.4 开通 ASR（豆包大模型流式语音识别）
- 控制台 → 产品「**智能语音技术 / 语音识别**」→ 开通「**流式语音识别·大模型版**」→ 创建应用，拿 **AppId** + **Access Token** + **ResourceId**。[需控制台核对]
- 对应代码：`VOLC_ASR_APP_ID` / `VOLC_ASR_ACCESS_TOKEN` / `VOLC_ASR_RESOURCE_ID`。
- **已验证的资源标识**：ResourceId = `volc.bigasr.sauc.duration`，endpoint = `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`，模型名 `bigmodel`（`volc-asr.ts:23-24,76`）。

### 2.5 开通 TTS（豆包大模型语音合成）
- 控制台 → 产品「**智能语音技术 / 语音合成**」→ 开通「**大模型语音合成**」→ 创建应用，拿 **appid** + **access token**，并**选定音色（voice_type / speaker）**。[需控制台核对]
- **已验证的资源标识**：ResourceId = `volc.service_type.10029`（大模型语音合成），endpoint = `wss://openspeech.bytedance.com/api/v3/tts/bidirection`（`volc-tts.ts:31-33`）。
- **音色示例**：`zh_female_tianmeixiaoyuan_moon_bigtts`（甜美小源，小可用的音色）。音色清单在火山控制台音色列表里选，每个音色一个 `voice_type` 字符串。[需控制台核对]
- ⚠️ **TTS 有两种鉴权模式，RTC 内联只接受「应用模式（appid+token）」**：
  - **应用模式**：`app: { appid, token }` —— RTC 的 `volcano_bidirection` Provider **只认这个**（`rtc.ts:85-88`）。
  - **API Key 模式**：HTTP/WS header `x-api-key: <UUID>` —— 仅用于你自己直连 TTS WS（非 RTC，见 §5.2），RTC 里用它会报 `1005005 bad handshake`。

### 2.6 凭据清单（逐项核对，缺一不可）

| 用途 | 环境变量 | 从哪拿 | 模式 |
|---|---|---|---|
| OpenAPI 签名 | `VOLC_ACCESS_KEY_ID` | §2.2 账号密钥 | 账号级 |
| OpenAPI 签名 | `VOLC_SECRET_ACCESS_KEY` | §2.2 账号密钥 | 账号级 |
| RTC 进房 + 起 AI | `VOLC_RTC_APP_ID` | §2.3 RTC 应用 | RTC |
| RTC token 签名 | `VOLC_RTC_APP_KEY` | §2.3 RTC 应用主密钥 | RTC |
| ASR 识别 | `VOLC_ASR_APP_ID` | §2.4 ASR 应用 | ASR |
| ASR 识别 | `VOLC_ASR_ACCESS_TOKEN` | §2.4 ASR 应用 | ASR |
| ASR 资源 | `VOLC_ASR_RESOURCE_ID` | `volc.bigasr.sauc.duration` | ASR |
| TTS 合成（RTC 内联） | `VOLC_TTS_APP_ID` | §2.5 TTS 应用 appid | TTS 应用模式 |
| TTS 合成（RTC 内联） | `VOLC_TTS_ACCESS_TOKEN` | §2.5 TTS 应用 token | TTS 应用模式 |
| TTS 资源 | `VOLC_TTS_RESOURCE_ID` | `volc.service_type.10029` | TTS |
| TTS 音色 | `VOLC_TTS_VOICE_TYPE` | §2.5 选的音色字符串 | TTS |
| TTS 直连（可选，非RTC） | `VOLC_API_KEY` | §2.5 API Key（UUID） | TTS API Key 模式 |

> 💡 **额度/计费**：豆包语音合成的「试用额度」是按**累计合成字数（text_words_lifetime）**算的，用完即停——和账户现金余额无关。生产前务必在控制台**开通正式计费**，否则会撞 quota 导致**小可静音但不报错**（见 §10 踩坑 ④）。[需控制台核对]

---

## 3. 拿 RTC SDK

### 3.1 前端 Web SDK
- npm 包：**`@volcengine/rtc`**（火山官方发布在 npm 公开 registry，直接 `npm i @volcengine/rtc` 即可，无需私有源）。
- 体积约 **12MB**，建议**动态 import 做 code-split**，不要进主 bundle（否则首屏暴涨 + 可能超 PWA Service Worker 预缓存上限）。依据 `useVolcRtc.ts:5-6,111`。
- 还有 OpenAPI 签名包：**`@volcengine/openapi`**（server 端，给 OpenAPI 请求做 V4 签名，`rtc.ts:29`）。它是 CommonJS，ESM 项目里用 `createRequire` 引入避免 interop 问题。

### 3.2 RTC token 生成器
- 火山的 RTC token 是**私有二进制格式（HMAC）**，不是标准 JWT。官方提供各语言的 token 生成源码。
- **直接复用官方的 `AccessToken` 类源码**（P003 用的是 `apps/server/src/rtc-token.cjs`，火山官方 BSD-3 授权的 token.js）。**不要手写移植**——格式细节多，自己写极易出 bug。
- 用法：`new AccessToken(appId, appKey, roomId, userId)` → `addPrivilege(发布/订阅, 0)` → `expireTime(秒级时间戳)` → `serialize()`（`rtc.ts:157-161`）。

### 3.3 平台覆盖
- `@volcengine/rtc` 是 Web SDK，浏览器 / WebView 通用。火山另有 Android / iOS / Flutter / 小程序原生 SDK（在火山 RTC 控制台「SDK 下载」获取）。[需控制台核对]
- 移动 App 可走「**原生薄壳 + WebView 加载 Web 核心**」，复用同一套 Web RTC 代码（这是小可手机端的做法）。

---

## 4. ASR：豆包大模型语音识别怎么用

### 4.1 RTC 模式（推荐）——只填配置，火山云侧帮你调
在 `StartVoiceChat` 的 `Config.ASRConfig` 里声明，火山云负责采音→识别→出文本，你不碰音频流：

```js
ASRConfig: {
  Provider: 'volcano',
  ProviderParams: {
    Mode: 'bigmodel',                          // 大模型版
    AppId: process.env.VOLC_ASR_APP_ID,
    AccessToken: process.env.VOLC_ASR_ACCESS_TOKEN,
    ApiResourceId: 'volc.bigasr.sauc.duration', // ⚠️ RTC 里字段名是 ApiResourceId
  },
}
```
依据 `rtc.ts:70-78`。

### 4.2 直连模式（可选）——你自己采音、自己连 ASR WS
如果不用 RTC、想自建管道（如端侧采音、WS pipeline），可直连豆包 ASR WebSocket：
- endpoint：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`
- 鉴权 header：`X-Api-App-Key: <AppId>`、`X-Api-Access-Key: <AccessToken>`、`X-Api-Resource-Id: volc.bigasr.sauc.duration`、`X-Api-Connect-Id: <uuid>`
- 协议：自定义二进制帧（4字节 header + 可选 sequence + 4字节 size + JSON/PCM payload），见 `volc-asr.ts:217-266` 的 `buildJsonFrame`/`buildAudioFrame`/`parseAsrFrame`。
- 握手 payload：`{ user, audio:{format:'pcm',codec:'raw',rate,bits:16,channel:1}, request:{model_name:'bigmodel', enable_punc:true, enable_itn:true, ...VAD参数} }`（`volc-asr.ts:64-93`）。
- **VAD 判停参数**（`vad_segment_duration` / `end_window_size` 等）官方 JS 文档渲染不全，名称需用 `DEBUG_ASR=1` 真机实测确认；火山对未知 request 字段通常忽略而非拒连，所以「加错名」最坏是不生效而非断流（`volc-asr.ts:77-92`）。儿童场景静音判停别低于 1000ms（吐字慢，否则半句被切）。

---

## 5. TTS：豆包大模型语音合成怎么用

### 5.1 RTC 模式（推荐）——配置声明，火山云侧合成
在 `StartVoiceChat` 的 `Config.TTSConfig` 里声明：

```js
TTSConfig: {
  Provider: 'volcano_bidirection',
  ProviderParams: {
    // ⚠️⚠️ 只能填 app + audio + ResourceId 这三块，多一个非法字段火山就拒整个 TTSConfig（见 §10 踩坑④）
    app: {
      appid: process.env.VOLC_TTS_APP_ID,
      token: process.env.VOLC_TTS_ACCESS_TOKEN,   // 必须「应用模式」appid+token，不能用 UUID API Key
    },
    audio: {
      voice_type: process.env.VOLC_TTS_VOICE_TYPE, // 音色，如 zh_female_tianmeixiaoyuan_moon_bigtts
      speech_rate: 0,                              // 语速 [-50,100]，0=正常
      pitch_rate: 0,                               // 音调，0=正常
    },
    ResourceId: 'volc.service_type.10029',
  },
}
```
依据 `rtc.ts:79-96`。

### 5.2 直连模式（可选）——自建管道时
- endpoint：`wss://openspeech.bytedance.com/api/v3/tts/bidirection`
- 鉴权 header：`x-api-key: <VOLC_API_KEY 的 UUID>`（小写！应用模式的 `X-Api-Access-Key` 是另一回事）、`X-Api-Resource-Id: volc.service_type.10029`、`X-Api-Connect-Id: <uuid>`（`volc-tts.ts:67-74`）。
- 事件协议（双向流式 TTS 2.0）：`StartConnection(1)` → `StartSession(100)` → `TaskRequest(200,feed文本)` → `FinishSession(102)`；收 `TTSSentenceStart(350)`=句开始(带文本)、`SentenceEnd-mid(351)`=句末标点中段(用来 flush 字幕)、`SessionFinished(152)`=整流结束。**别把 351 当流结束**（每个标点都发，误判会只播第一句就锁死，`volc-tts.ts:38-44,113-135`）。
- 音频参数：`{format:'mp3', sample_rate:24000}`（`volc-tts.ts:84-90`）。

### 5.3 音量控制
- RTC 模式下 TTS 的服务端音量参数（旧 `loudness_ratio`）**已被火山判为非法字段删除**。改由**客户端** `engine.setPlaybackVolume(50)` 控制远端播放音量（`useVolcRtc.ts:138-142`）。

---

## 6. LLM：CustomLLM 回调怎么接

### 6.1 在 StartVoiceChat 里声明
```js
LLMConfig: {
  Mode: 'CustomLLM',
  Url: 'https://你的域名/v1/chat/completions?session=<roomId>&token=<登录JWT>',
  ModelName: 'xiaoke',                          // 任意标识，会原样回传
  APIKey: process.env.CUSTOM_LLM_API_KEY || 'none', // 火山调你端点时带的 Bearer，用于鉴权
  SystemMessages: [],
}
```
依据 `rtc.ts:97-104`。
- **Url 必须是公网 HTTPS**（火山云回调你的服务器）。
- **用 query 透传上下文**：`?session=roomId`（取热更 prompt）、`?token=登录JWT`（你的端点据此注入这个用户的记忆）。火山回调会**保留 Url 上的 query**，这是把「身份/会话」带进无状态回调的关键技巧（`rtc.ts:49-55,100`）。

### 6.2 你的端点要实现什么（OpenAI 兼容 SSE）
火山把 ASR 文本 + 对话历史以 **OpenAI ChatCompletion 格式** POST 过来，你要：
1. 取最后一条 `user` message 的文本（content 可能是 string 或 content-parts 数组，都要兜底，`custom-llm.ts:35-47`）。
2. 拼 system prompt（人设 + 记忆 + 护栏——这是你的核心价值）。
3. 调你的 LLM，以 **SSE 流**返回，每个 chunk 形如：
   ```
   data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你"},"finish_reason":null}]}
   ```
   首 chunk 带 `delta.role=assistant`，结束 chunk `finish_reason:"stop"`，最后必须发 `data: [DONE]`（火山要求的终止符，`custom-llm.ts:140-171`）。
4. **SSE chunk 必须串行写出**（`writeSSE` 是 async，并发写会乱序，`custom-llm.ts:150-154`）。
5. **错误也要吞成正常 SSE 回复**（如「小可有点累了」），别让端点 500——否则火山侧整轮失败，孩子听到的是死寂（`custom-llm.ts:165-168`）。

### 6.3 LLM 可任意替换
你的端点背后接什么 LLM 完全自由：P003 用 `LLM_PROVIDER` env 在 Gemini / DeepSeek 间切（`custom-llm.ts:133-134`）。只要能流式输出文本即可——这正是 CustomLLM 模式的最大价值。

### 6.4 网关注意（如果你的端点在 nginx/CF 后面）
- SSE 流式响应必须关闭反向代理缓冲：nginx `proxy_buffering off;`，否则火山收不到流式 chunk（会整段卡住或超时）。
- CF 等网关对长 reasoning 的非流式请求 ~100s 会 524；用 SSE 流式可规避（参考记忆 `feedback_cf_gateway_524_needs_streaming`）。

---

## 7. server 端组装 StartVoiceChat（完整参考）

把 §4/§5/§6 拼起来，server 端用 AK/SK 签名调火山 OpenAPI。完整可运行结构见 `rtc.ts:57-130`，骨架：

```js
const RTC_HOST = 'rtc.volcengineapi.com';
const RTC_REGION = 'cn-north-1';
const RTC_VERSION = '2024-12-01';

// 1) 组装 VoiceChat 配置
const body = {
  AppId: VOLC_RTC_APP_ID,
  RoomId: roomId,
  TaskId: roomId,                         // 火山要求 TaskId 非空，一房一任务
  AgentConfig: {
    TargetUserId: [userId],
    WelcomeMessage: '欢迎语…',             // AI 进房主动说的第一句
    UserId: 'xiaoke_bot',                 // ★ 必须 ASCII，中文会报 invalid UserID
    EnableConversationStateCallback: true,// 开了才会推 LISTENING/THINKING/SPEAKING 状态
  },
  Config: {
    ASRConfig: { /* §4.1 */ },
    TTSConfig: { /* §5.1 */ },
    LLMConfig: { /* §6.1 */ },
    InterruptMode: 0,                     // 0 = 可打断（全双工 barge-in）
  },
};

// 2) V4 签名（@volcengine/openapi 的 Signer）
const reqData = { region: RTC_REGION, method: 'POST',
  params: { Action: 'StartVoiceChat', Version: RTC_VERSION },
  headers: { Host: RTC_HOST, 'Content-Type': 'application/json' }, body };
const signer = new Signer(reqData, 'rtc');
signer.addAuthorization({ accessKeyId: VOLC_ACCESS_KEY_ID, secretKey: VOLC_SECRET_ACCESS_KEY });

// 3) POST，检查 result.ResponseMetadata.Error
const res = await fetch(`https://${RTC_HOST}?Action=StartVoiceChat&Version=${RTC_VERSION}`,
  { method:'POST', headers: reqData.headers, body: JSON.stringify(body) });
```

对应的 `/api/rtc/start` 路由还做了：生成 RTC token、从 `Authorization` 头取登录 JWT 透传给 CustomLLM、onboarding 时换欢迎语、工作台 prompt override。停止用 `StopVoiceChat`（同样签名，body 只需 `AppId/RoomId/TaskId`，`rtc.ts:185-197`）。

---

## 8. 前端进房（@volcengine/rtc）

完整 Hook 见 `useVolcRtc.ts`，关键步骤：

```js
// 1) 拿 server 起的会话
const { appId, roomId, userId, token } = await fetch('/api/rtc/start', {...}).then(r=>r.json());

// 2) 动态 import SDK（12MB，code-split）
const rtcMod = await import('@volcengine/rtc');
const VERTC = rtcMod.default;
const engine = VERTC.createEngine(appId);

// 3) 监听二进制消息：AI 状态机 + 字幕
engine.on(VERTC.events.onRoomBinaryMessageReceived, handleBinary);
engine.on(VERTC.events.onAutoplayFailed, () => setNeedTapToPlay(true)); // autoplay 被拦

// 4) 进房（进房成功即视为连上，不等麦克风采集，避免权限弹窗卡 UI）
await engine.joinRoom(token, roomId,
  { userId, extraInfo: JSON.stringify({ call_scene: 'RTC-AIGC', user_id: userId }) },
  { isAutoPublish: true, isAutoSubscribeAudio: true, roomProfileType: RoomProfileType.chat });
engine.setPlaybackVolume?.(50);                 // 远端音量

// 5) 采麦 + 发布（异步，权限慢/失败不阻塞连接与开场白）
engine.startAudioCapture().then(() => engine.publishStream(MediaType.AUDIO));
```

### 8.1 二进制消息解析（状态 + 字幕）
火山通过 RTC 二进制消息推送 AI 状态和字幕，**TLV 编码**（4字节 type + 4字节 big-endian length + value，`useVolcRtc.ts:13-23`）：
- `type='conv'`：AI 状态机 `Stage.Code`——`1`监听/`2`思考/`3`说话/`4`被打断/`5`结束（`useVolcRtc.ts:9,67-72`）。
- `type='subv'`：字幕，`data[0].{text,userId}`——userId==自己=你说的（ASR 转写），否则=AI 说的（`useVolcRtc.ts:73-79`）。

### 8.2 离房
`engine.stopAudioCapture()` → `engine.leaveRoom()` → `destroyEngine(engine)`，并 POST `/api/rtc/stop` 让 server 调 `StopVoiceChat`（`useVolcRtc.ts:233-257`）。

---

## 9. 环境变量清单（server `.env.local`，全部脱敏）

```bash
# ── OpenAPI 签名（账号级 AK/SK）──
VOLC_ACCESS_KEY_ID=
VOLC_SECRET_ACCESS_KEY=

# ── RTC ──
VOLC_RTC_APP_ID=
VOLC_RTC_APP_KEY=

# ── ASR（豆包大模型识别）──
VOLC_ASR_APP_ID=
VOLC_ASR_ACCESS_TOKEN=
VOLC_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
# VOLC_ASR_WS_URL / VOLC_ASR_VAD_SEGMENT_MS 等可选覆盖

# ── TTS（豆包大模型合成，RTC 用应用模式 appid+token）──
VOLC_TTS_APP_ID=
VOLC_TTS_ACCESS_TOKEN=
VOLC_TTS_RESOURCE_ID=volc.service_type.10029
VOLC_TTS_VOICE_TYPE=zh_female_tianmeixiaoyuan_moon_bigtts
# VOLC_API_KEY=         # 仅自建直连 TTS WS 用（UUID，非 RTC）

# ── CustomLLM 回调 ──
CUSTOM_LLM_URL=https://你的域名/v1/chat/completions
CUSTOM_LLM_API_KEY=     # 火山回调时带的 Bearer，端点校验用
LLM_PROVIDER=gemini     # 或 deepseek，决定背后接哪个 LLM
GEMINI_API_KEY=         # 你选的 LLM 的凭据
```

> 🔒 **secret 红线**：以上全部只存 server 端 `.env.local`（`chmod 600` + `.gitignore`），**绝不进前端、git、记忆**。前端只拿到 `{appId, roomId, userId, token}`，凭据全在 server 组装（`rtc.ts:14-16`）。

---

## 10. 踩坑清单【真金白银，逐条预检】

| # | 坑 | 现象 | 解 | 依据 |
|---|---|---|---|---|
| ① | `AgentConfig.UserId` 用中文 | StartVoiceChat 报 `invalid UserID` | AI 的 UserId 必须 **ASCII**（如 `xiaoke_bot`） | `rtc.ts:66` |
| ② | RTC TTS 用了 UUID API Key 当 token | `1005005 bad handshake` | RTC `volcano_bidirection` 只认**应用模式 appid+token** | §2.5 |
| ③ | 注册了端侧 AI 降噪扩展(extension-ainr) | 手机 Chrome `registerExtension` 卡死，connecting 永久挂起 | **别注册端侧降噪**——火山云侧本有 3A 回声消除/降噪 | `useVolcRtc.ts:117-118` |
| ④ | **TTSConfig 含非法字段** | 小可**静音但不报错**（preParamCheck unknown fields → 拒整个 TTSConfig → 回退试用资源撞 quota `45000292`） | TTSConfig 只留 `app`+`audio`+`ResourceId`；火山 2026-06 收紧 schema，`cluster`/`loudness_ratio` 已成非法字段 | `rtc.ts:82-93` |
| ⑤ | TTS 试用额度耗尽 | 同样**静音不报错**（agent 推空音频流） | 控制台开通正式计费；额度按累计合成字数算，与现金余额无关 | §2.6 |
| ⑥ | autoplay 被浏览器拦 | 进房了但听不到 AI | 监听 `onAutoplayFailed`，用户手势内 `engine.play(uid)` 恢复 | `useVolcRtc.ts:121-125,180-193` |
| ⑦ | 进房等麦克风采集 | 权限弹窗慢 → UI 卡 / 开场白延迟 | 进房成功即判连上，采麦异步（失败也不阻塞开口） | `useVolcRtc.ts:135-158` |
| ⑧ | TTS 把 351 事件当流结束（直连模式） | 只播第一句就锁死后续音频 | 351=句末标点中段(每标点都发)，真结束是 152/ws.close | `volc-tts.ts:38-44` |
| ⑨ | CustomLLM 端点在网关后未关缓冲 | 流式卡住/超时 | nginx `proxy_buffering off;` | §6.4 |
| ⑩ | prompt 中途想换 | 火山不支持运行中改 LLM prompt | prompt 存你方内存(roomId→prompt)，CustomLLM 每轮取最新，可热更不重连 | `rtc.ts:49-55,217-225` |

> 调试技巧：火山 agent 运行期错误**不在 StartVoiceChat 返回里**，而是通过前端 `onRoomBinaryMessageReceived`（type=conv → ErrorInfo）推送。浏览器测 WebRTC 别用反指纹浏览器（camoufox 的 `RTCPeerConnection` 是 undefined）——用 Playwright Chromium + `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`。真机调试 WebView 用 USB 调试 + `adb forward` + CDP（参考记忆 `project_p003_android_apk`）。

---

## 11. 端到端验证

最小闭环验证（不依赖 UI）：
1. **server 起 task**：`curl -X POST https://你的域名/api/rtc/start` → 应返回 `{ok:true, appId, roomId, userId, token, taskId}`，无 `ResponseMetadata.Error`。
2. **CustomLLM 端点单测**：直接 `curl -N` 你的 `/v1/chat/completions`，body 塞一条 OpenAI 格式 user message，应看到 SSE 流式 chunk + `data: [DONE]`。这步能独立验证「大脑」对不对，不用碰火山。
3. **真机/Chromium 全链路**：进房 → 说话 → 看到 ASR 字幕（type=subv 自己的）→ 听到 AI 回复 + 看到 AI 字幕 → 状态机 LISTENING→THINKING→SPEAKING 流转。
4. **打断测试**：AI 说话中插话，应立即停（InterruptMode=0）。

> ⚠️ 验证铁律：开发者**自己**跑通公网 E2E 再说「完成」，别甩命令给用户。小可静音类 bug（坑④⑤）正是因为「看起来连上了」但没真听一句，必须真听到声音才算过。

---

## 附：与「自建管道」（非 RTC）的取舍

RTC 模式把 ASR/TTS/回声消除/打断全托管给火山云，**接入最快、延迟最优、最省心**，代价是音频管道是黑盒。若需要端侧采音、隐私边界（音频不出端）、或极致定制，可用 §4.2/§5.2 的直连 WS 自建 cascade 管道（ASR→LLM→TTS 自己串），但要自己处理 VAD 判停、回声消除、打断、字幕同步——工程量大得多（参考 `2-Projects/realtime-voice-agent/`）。**新手强烈建议从 RTC 模式起步。**

---

署名：cc（Claude）｜ 2026-06-25
