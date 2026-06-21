# docs/35 · 火山 RTC 实时对话集成 —— 实施方案 + 验证成果

> **缘起**：docs/34 定 D（端侧 ASR 撞 AEC 自循环坑 → 回归云端火山 RTC）。2026-06-21 cc 实施并 **web 端 E2E 验证通过（川哥浏览器实测全双工对话）**。
> **状态**：✅ 后端 CustomLLM 端点 + 火山 RTC web demo 全链路跑通。🔜 整合到手机端小可 app（用手机 app 界面）。
> **关联**：决策 docs/34 / 选型史 docs/31 / 部署 SOP `p003-deploy-ops` skill。日期：2026-06-21。

---

## 0. 一句话

**火山 RTC 全双工（豆包 ASR + TTS + 3A 回声消除 + 语义判停 + barge-in）+ 我们的小可大脑（CustomLLM 回调 → Gemini + 方舟世界观 + 记忆 + 启蒙）= 真·小可实时语音。** web 已验证，正集成到手机 app。

---

## 1. 架构（已验证）

```
[客户端 RTC SDK]  采音 + 3A回声消除 + VAD + barge-in（火山内建）
      ↕ WebRTC
[火山 AIGC-RTC Server 云]  豆包 ASR(bigmodel) + 豆包 TTS(小可音色) + 编排 + 语义判停
      ↕ CustomLLM 回调（OpenAI 兼容 SSE）
[我们的 server /v1/chat/completions]  ARK世界观 + AI安全基座 + 课程护栏 + AI启蒙 + Gemini  ← 大脑全保留
```

火山只当「语音 I/O + 编排管道」；小可的灵魂（世界观/记忆/启蒙/LLM）全在我们 server。

---

## 2. 已完成（2026-06-21 验证）

| 环节 | 产出 | 验证 |
|---|---|---|
| CustomLLM 端点 | `apps/server/src/routes/custom-llm.ts`（OpenAI 兼容 SSE，复用 `ARK_WORLDVIEW_BASE`+`AI_SAFETY_BASELINE`+`curriculumKG`+`buildAiLiteracyGuide`+`streamChat`） | tsc + 本地 curl ✓ |
| 世界观单一真相源 | `apps/server/src/prompts.ts`（`ARK_WORLDVIEW_BASE` 从 pipeline.ts 抽出，WS + CustomLLM 共用，防漂移） | pipeline 行为不变 ✓ |
| 生产部署 | scp 4 文件 → `/opt/p003/server/src/` + `pm2 restart p003-voice`（备份 `/opt/p003/_backup/20260621-114021-rtc-customllm`） | LLM/ASR/TTS ready ✓ |
| nginx | 加 `location /v1/`（**`proxy_buffering off`** + `read_timeout 300s`），备份 `/tmp/kidshub-ai.nginx.bak` | nginx -t + reload ✓ |
| 公网 E2E | `POST https://kidshub-ai.hahaxiong.cc/v1/chat/completions` | **真实 Gemini 小可，回复带方舟世界观（"指挥官/方舟/织女星系"）** ✓ |
| 火山 RTC demo | `volcengine/rtc-aigc-demo`（/tmp）+ 真实凭证 + `Custom.json` | **StartVoiceChat=ok + 川哥浏览器全双工实测通过** ✓ |

---

## 3. 火山 RTC 配置 + 坑清单（Custom.json，都踩过）

| 项 | 值 | 坑 |
|---|---|---|
| ASR | `Provider:volcano` `Mode:bigmodel` `ApiResourceId:volc.bigasr.sauc.duration` | 我们 standalone 一直用的 SAUC 大模型，童声强 |
| TTS | `Provider:volcano_bidirection` `voice_type:zh_female_tianmeixiaoyuan_moon_bigtts`（甜美小源=小可音色） | 双向流式 |
| LLM | `Mode:CustomLLM` `Url:https://kidshub-ai.hahaxiong.cc/v1/chat/completions` | OpenAI 兼容 SSE（`text/event-stream` + `data:[DONE]`） |
| **AgentConfig.UserId** | `xiaoke_bot`（ASCII） | ★ **中文"小可"报 `invalid UserID`**，必须 ASCII |
| **TaskId** | `=RoomId` | ★ **必填**，demo 默认空报 `invalid TaskId`；fix=`app.js` getScenes 加 `VoiceChat.TaskId=VoiceChat.RoomId` |
| InterruptMode | `0` | 可打断（getScenes `isInterruptMode=true`） |
| **nginx /v1** | `proxy_buffering off` | ★ **SSE 必须关 buffering**，否则火山收不到流式增量（默认转发会缓冲到结束） |
| nodemon | — | ★ 只 watch `Server/` 根，**改 `scenes/Custom.json` 不 reload**，要 kill+restart demo server |

**凭证（`.env.local`，git 已忽略，脱敏）**：`VOLC_ACCESS_KEY_ID/SECRET`（OpenAPI AK/SK）+ `VOLC_RTC_APP_ID/KEY`（从 `~/Documents/.../火山引擎实时音视频 key.rtf` 脱敏导入）+ `VOLC_ASR_*` + `VOLC_TTS_*`（豆包）。

---

## 4. 手机 app 集成方案（任务3，进行中）

现有手机 app = **原生 Compose WebView 薄壳 + Web 核心**（`apps/web/src/mobile`）。川哥要求**用手机 app 现有界面**（UI 复用 Web）。两条路：

| 路 | 做法 | 取舍 |
|---|---|---|
| **路1 Web SDK（先试）** | Web 核心集成火山 RTC **Web SDK**（`@volcengine/rtc`），在 WebView 里跑 WebRTC；原生壳只管 WebView + 麦克风权限（已有）。退役端侧 AudioEngine/Zipformer | 改动集中在 Web 层，复用现有壳；**AEC 由 WebRTC 统一音频管线 + 火山云 3A 解决**（不再"原生录音/Web播放分裂"那个坑）。前台对话不碰后台挂起问题 |
| 路2 Android SDK（备选） | 原生壳集成火山 RTC **Android SDK** + JS Bridge，Web 只做 UI | AEC/性能最好（原生 3A），但原生集成 + Bridge 改动大 |

**先试路1**：WebView 支持 WebRTC（getUserMedia + RTCPeerConnection），火山 RTC Web SDK 在 WebView 能跑；WebRTC 自带 echoCancellation + 火山云 3A，AEC 应解决；前台对话（孩子盯屏）不触发后台挂起。若 WebView 体验/AEC 不达标，再上路2。

### 4.1 路1 实施成果（2026-06-21 晚 · 手机 Chrome + adb CDP 真机验证通过）

川哥真机实测：**秒连 + 有声音 + 对话通 + 可打断 ✓**（先用手机 Chrome 验证，原生 APK 待 Block D）。

- **Block A** `routes/rtc.ts` + `rtc-token.cjs`：`/api/rtc/start|stop`，凭证全 server 组装、前端只拿 token；签名调火山 OpenAPI 起 AI。
- **Block B** `mobile/useVolcRtc.ts`：`@volcengine/rtc` 动态 import（code-split，主 bundle 不含 12MB SDK）+ join + 采麦 + 自动订阅播 AI 音频 + tlv 解析（状态/字幕）。
- **Block C** `mobile/MobileMain.tsx`：复用手机 app UI（小可/字幕/圆钮），全双工常开，圆钮开始/挂断。
- **★ 踩坑（CDP 实测定位，都已修）**：
  1. **AI 降噪扩展 `@volcengine/rtc/extension-ainr` 在手机 Chrome 卡死 `registerExtension`**（加载降噪 WASM 挂起，try/catch 抓不住"卡住"）→ connecting 永久"正在叫醒"。**去掉端侧降噪**（火山云有 3A）→ 秒连。
  2. **采麦阻塞 UI**：`startAudioCapture` 等麦克风权限慢 → 改 **join 成功即 connected**，采麦异步（权限慢不卡界面/不卡小可开口）。
  3. **autoplay**：浏览器拦 AI 音频 → `needTapToPlay` 遮罩点屏恢复（CDP 实测点圆钮手势下 `paused:false` 正常播）。
  4. **音量过大**：两头降 → server TTS `loudness_ratio:0.6`（env `VOLC_TTS_LOUDNESS` 可调）+ 客户端 `setPlaybackVolume:50`。
  5. **缺用户字幕**：火山字幕 binary `userId===自己` → 用户 ASR 字幕（store `userSubtitle`，MobileSubtitle 上方小灰字「你：」）。
- **★ CDP 真机调试范式（省去让川哥手动复现）**：手机开 USB 调试 → `adb forward tcp:9222 localabstract:chrome_devtools_remote` → `curl /json/list` 找 tab → node v22 global WebSocket 连 CDP → `Browser.grantPermissions`(audioCapture) 绕权限弹窗 + `Runtime.evaluate` 模拟点击 + 抓 `consoleAPICalled`/audio 元素 `paused/muted/vol`。

### 4.2 ⚠️ 未解决：小可音量走"通话流"，手机音量键调不到

川哥实测：小可声音走 **通话音量流（VOICE_COMMUNICATION）**，手机音量键默认调媒体流（STREAM_MUSIC）→ 调不到小可（要切到"通话音量"才行，反直觉）。

- **根因**：**Android Chrome 的 WebRTC 远端音频为做 AEC 默认走通话流**，Web/JS 层无法改浏览器这个行为（火山 RTC Web SDK 也受限）。
- **解法（指向 Block D 原生壳）**：原生壳用 `AudioManager` 控制音频流路由到 `STREAM_MUSIC`，或直接上火山 RTC **Android SDK**（原生层完全掌控音频流类型 + 音量）。Chrome 阶段无优雅 Web 解。

### 4.3 ✅ kidshub 记忆 × RTC 打通（2026-06-21 深夜，端到端验证通过）

原 CustomLLM 端点**匿名**（无 accountId → 无个性化记忆，川哥实测"记忆没通"）。打通链路：

> 登录 JWT（sessionStorage `kidshub.token`）→ `useVolcRtc` 带 `Authorization` → `/api/rtc/start` 提取 → **CustomLLM 回调 Url 拼 `?token=<jwt>`** → 火山回调**保留 query**（实测确认）→ `custom-llm` `verifyAuthToken(query.token)` → accountId → `assembleSystemPrompt(base, null, authContext, …)` → profile-store 注入（昵称/年龄/兴趣/情绪/方舟经历）。

- **端到端实测**（CDP `fetch /v1?token=` 问"记得我喜欢什么"）：小可答「**天天**，我记得你喜欢**乌龟、火箭、数学、物理**…生态缸的小嫩芽长高了吗」= 昵称 + 兴趣 + 世界观融合 ✓。
- **★ 关键确认**：火山 CustomLLM 回调**保留 Url query**（`?token=` 透传成功，server log `收到回调 token=YES len=201`）——这是记忆映射可行的前提（否则只能改用别的透传通道）。
- **session token 存 `sessionStorage`（非 localStorage）**，排查时一度看错位置。
- ⚠️ 安全：`/v1` 带 token 但端点未强鉴权（待办）；token 走 Url query（火山内部链路，demo 可接受，产品化可换 header/短期 session token）。

---

## 5. 待办

1. ✅ ~~手机 app 集成（路1）~~ —— 已实施 + Chrome 真机验证（§4.1）。
2. ⚠️ **Block D 原生壳**（让 APK 可用 + 解音量流）：① 音量走通话流（§4.2，原生 AudioManager/火山 Android SDK 路由到媒体流）② 禁端侧 AudioEngine 让 WebView 火山 RTC 独占麦 ③ 重编 APK。
3. ⚠️ **`/v1` 端点加鉴权 + 限额**（`CUSTOM_LLM_API_KEY` Bearer + per-IP），现公网裸奔防白嫖 Gemini。
4. ✅ ~~记忆 session 映射~~ —— **已打通**（见 §4.3：token 走 CustomLLM Url `?token=`，火山保留 query，端到端验证小可记得"天天"+ 兴趣）。
5. 端侧 Zipformer/AudioEngine 退役（保留代码作未来"离线/壁垒"预研）。

## 6. 回滚

- server：`cp /opt/p003/_backup/20260621-114021-rtc-customllm/{pipeline,index}.ts /opt/p003/server/src/` + 删 `prompts.ts`/`routes/custom-llm.ts` + `pm2 restart p003-voice`。
- nginx：`cp /tmp/kidshub-ai.nginx.bak /etc/nginx/sites-enabled/kidshub-ai` + `nginx -s reload`。

---

> 署名：cc（Claude）| 2026-06-21
