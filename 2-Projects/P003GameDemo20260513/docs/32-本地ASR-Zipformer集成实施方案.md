# docs/32 · 小可本地 ASR(Zipformer-zh)集成实施方案

> 选型已锁(见 [docs/31 §12](31-端侧语音ASR-TTS开源选型评审报告-team四发.md)):**本地 sherpa-onnx + 流式 Zipformer-zh 听 → 云 LLM 想 → 云豆包 TTS 说**,情绪走云 LLM 文本推断,判停用 Zipformer 自带 endpointing,AEC 靠原生层 TTS 播放时静音 ASR。本文是把这条已锁链路落到工程的实施方案。
>
> 状态:**v0.2(team 四发对抗评审已收敛,2026-06-21)**。下方 §0–§10 为 v0.1 推演留痕;**§11 是评审收敛后的权威裁决与修正设计,以 §11 为准**。四家原始存 [`_doc32-asr/round1/`](_doc32-asr/round1/)。下一步卡在 P0 真机首验门槛(见 §11.F)。

---

## 0. 就绪度复盘(全部读源码核实,非文档转述)

| 事实 | 证据 | 状态 |
|---|---|---|
| android-shell 已是功能性原生壳(WebView + 全屏 + 麦克风权限 + onPermissionRequest 托管 getUserMedia + JS Bridge 注入) | `apps/android-shell/.../MainActivity.kt` | 已验证 |
| sherpa-onnx 完整 Kotlin API(22 .kt,含 **`OnlineRecognizer.kt`** = 流式 ASR 主类、`OnlineStream`、`Vad`、`KeywordSpotter`)已在仓库 | `apps/android-shell/.../com/k2fsa/sherpa/onnx/` | 已验证 |
| 预编译 native `.so`(`libsherpa-onnx-jni` + `libonnxruntime` + `c-api`,arm64-v8a)已在 jniLibs | `apps/android-shell/app/src/main/jniLibs/arm64-v8a/` | 已验证 |
| `OnlineRecognizer` 已带 `isEndpoint(stream)` + `EndpointConfig`(默认 rule1=2.4s / rule2=1.4s / rule3=20s)+ `enableEndpoint=true` | `OnlineRecognizer.kt:66-153, 790-797` | 已验证 |
| `getModelConfig()` 注册表含 **type 9 = `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23`**(纯中文,int8 encoder)与 **type 20 = `sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`**(2025 新版) | `OnlineRecognizer.kt:321-332, 442-453` | 已验证 |
| 唤醒词(WakeWordBridge)已用 `AudioRecord(VOICE_RECOGNITION,16k)` + `AcousticEchoCanceler` + `NoiseSuppressor` + 麦克风互斥契约 | `WakeWordBridge.kt` | 已验证 |
| **当前 mobile ASR 实际仍是云火山**:web `getUserMedia → AudioWorklet PCM16 → ws.send(binary) → server volc-asr → asr.partial/final`;判停靠火山 server VAD(definite),前端能量 VAD 仅"抢跑兜底" | `voice-client.ts:375-567`、`providers/volc-asr.ts` | 已验证 |
| **server 已有 `chat.trigger`(文本直入 LLM→TTS,绕开 ASR)**,且已计入 chat_round 限额 | `server/src/index.ts:95,162-165`、`pipeline.ts:162-163` | 已验证 |
| web↔原生 JS Bridge 契约单一真源:`KidshubNative.{isWakeWordAvailable,startWakeListening,pauseWakeListening}` / `KidshubWeb.{onWakeWord,onNativeReady}` | `apps/web/src/mobile/bridge.ts` | 已验证 |
| assets 现仅有 `kws-model/`(唤醒词),**尚无 ASR Zipformer 模型** | `apps/android-shell/app/src/main/assets/` | 已验证 |
| 单一 `libsherpa-onnx-jni.so` 含 OnlineRecognizer 能力(同 .so 既跑 KWS 也跑 ASR) | sherpa-onnx 官方预编译惯例 | 推断(高)·P1 首验 |

**结论**:on-device ASR **不是从零起**。= 复用唤醒词那套(AudioRecord + sherpa JNI + AEC 抑声)+ 加一个 `OnlineRecognizer` 实例 + 翻转"对话期"麦克风所有权(从 web getUserMedia 翻给原生)+ 扩 JS Bridge + 判停换 Zipformer endpointing + AEC 物理静音 + ASR final 经 `chat.trigger` 入 LLM。**server 近零改**。

---

## 1. 目标架构(数据流翻转)

**当前(云火山,mobile 仍走这条):**
```
web getUserMedia → AudioWorklet PCM16 → resample16k → ws.send(binary) → server volc-asr
                                                                          → asr.partial/final → web UI
判停 = 火山 server VAD definite(asr.final);前端能量 VAD 抢跑兜底
```

**目标(端侧 Zipformer):**
```
原生 AudioRecord(持麦) → OnlineRecognizer 流式 → partial / isEndpoint / final
   → JS Bridge(KidshubWeb.onAsrPartial/onAsrEndpoint/onAsrFinal) → web
   → web 把 final 经 voiceClient.sendChatTrigger(text) → server LLM→TTS(现成)
判停 = OnlineRecognizer.isEndpoint()(童声调过的 EndpointConfig)
```

核心翻转:**对话录音期麦克风由原生持有**(不再 web getUserMedia),web 不再上传 PCM,server 不再跑火山 ASR(mobile 端侧模式)。纯浏览器/降级时仍走云火山(见 §8)。

---

## 2. 麦克风所有权状态机(唤醒 → ASR → TTS 无缝衔接)

| 态 | 麦克风归属 | 行为 |
|---|---|---|
| idle(待唤醒) | 原生 | 原生持麦跑 KWS「小可小可」(现状) |
| 唤醒命中 | 原生 | **不释放麦,KWS 流 → 切 OnlineRecognizer 流**(设计点 ②) |
| ASR 中 | 原生 | 持麦跑 OnlineRecognizer,推 `onAsrPartial`;`isEndpoint` → `onAsrFinal` |
| thinking/speaking(TTS 播) | 原生 | **物理静音/挂起 ASR**(AEC,§6);**保留 KWS** 监听打断(现状已支持) |
| 多轮 followup | 原生 | TTS 播完 → 原生重开 ASR(对应现有 `MAX_FOLLOWUP_TURNS`) |
| PTT(按住说话) | 原生 | 按下开 ASR(关 auto-endpoint),松手停(不靠端侧判停) |

PTT 与 auto(唤醒/followup)两模式:auto 用 `isEndpoint` 自动收尾;PTT 由松手 `stopAsr()` 收尾。

---

## 3. JS Bridge 协议扩展(`bridge.ts` ↔ 新 `AsrBridge.kt`)

`NativeBridge` 新增:
```ts
isOnDeviceAsrAvailable(): boolean;          // 端侧 ASR 是否就绪(模型加载成功)
startAsr(mode: 'auto' | 'ptt'): void;       // auto=endpoint 自动停;ptt=松手停
stopAsr(): void;
notifyTtsState(speaking: boolean): void;    // AEC:TTS 播放时静音 ASR(§6)
```
`WebBridge` 新增:
```ts
onAsrPartial(text: string): void;           // 流式逐字(喂字幕)
onAsrEndpoint(): void;                       // 端侧判停命中 → web finishTurn
onAsrFinal(text: string): void;             // 整句最终文本 → web sendChatTrigger
```
**向后兼容铁律**:纯浏览器无 `window.KidshubNative` → `isOnDeviceAsrAvailable()` 视为 false → 自动回退云火山(现状路径不动)。`/m` 页在纯浏览器仍可跑。

---

## 4. 原生实现(`AsrBridge.kt`,WakeWordBridge 的兄弟)

- **复用**唤醒词那套:`AudioRecord(VOICE_RECOGNITION, 16k, MONO, PCM16)` + `AcousticEchoCanceler` + `NoiseSuppressor` best-effort 绑定。
- `OnlineRecognizer` 实例:`getModelConfig(选定 type)` + `enableEndpoint=true` + 童声调过的 `EndpointConfig`。
- 录音线程:`read → acceptWaveform → while(isReady) decode → getResult().text`(增量 → `onAsrPartial`)→ `isEndpoint(stream)` 命中 → `onAsrFinal(text)` + `reset(stream)`。
- **麦克风仲裁(关键)**:KWS 与 ASR **不能同时各开一个 `AudioRecord`**。建议把 KWS + ASR 收敛进单一 `AudioEngine`(管一个 AudioRecord,按状态把 16k PCM 帧喂给 KeywordSpotter 流 或 OnlineRecognizer 流),避免双开/抢占/释放竞态(设计点 ⑤)。
- 失败优雅降级:模型缺失/初始化失败 → `isOnDeviceAsrAvailable()=false` → web 自动回退云火山。
- **模型选型(设计点 ①)**:type 9(zh-14M,最小最快,中端机/童声延迟友好) vs type 20(zh-int8-2025,可能 CER 更好但更大)。建议 **14M 起步打通链路**,真机童声 CER 实测后再决定是否换 20。⚠️ docs/31 的"14MB"是参数量(14M params)推估的落盘体积,**真实下载体积(encoder+decoder+joiner+tokens)必须实测核实**,不照搬。

---

## 5. 判停(Zipformer endpointing 换火山 definite)

- mobile 端侧模式:用 `OnlineRecognizer.isEndpoint()`;**弃** server 火山 definite + 前端能量 VAD。
- `EndpointConfig` 童声调参(源码默认 rule1=2.4s / rule2=1.4s):
  - rule2(`mustContainNonSilence=true`,说话后尾静音):童声吐字慢、句间停顿长 → **保守起点 ~1.2–1.5s**(宁可多等也别切断孩子),真机调。⚠️ docs/31 写的"0.3s"对童声**太激进**,会频繁截断,不采纳为起点。
  - rule1(无需说话的纯静音兜底)2.4s、rule3(maxUtterance)20s 先用默认。
- web 侧:`onAsrEndpoint` → `finishTurn()`(替现有唤醒录音的固定 `WAKE_RECORD_MS=6000ms` 窗 + `vad.speech_end`)。

---

## 6. AEC 自激(docs/31 标的致命坑)

问题:TTS 在 WebView 里播 → 原生 ASR 持麦录到小可自己的声音 → 全量转写污染 / 自触发死循环(比 KWS 严重:KWS 只匹配特定词,ASR 全量转写,小可每句话都会被当用户输入)。

方案:**TTS 播放时原生层物理静音/挂起 ASR**(不靠软件 AEC 兜底):
- web `onTtsAudio`(已有时序点,现做 duckTts+startWakeListening)→ 加 `notifyTtsState(true)` → 原生 `AudioEngine` 暂停把帧喂 OnlineRecognizer(物理丢弃输入)。
- web `onPlaybackEnd`(已有,现做 restoreTts)→ 加 `notifyTtsState(false)` → 原生恢复 ASR。
- **KWS 打断保留**:speaking 期继续跑 KWS 让"小可小可"能打断(现状靠 AcousticEchoCanceler 抑制自声,对特定词足够);ASR 对自声敏感 → 必须物理静音,不能只靠 AEC。

---

## 7. server 改动(最小化)

- **复用 `chat.trigger`**:原生 ASR final → web `voiceClient.sendChatTrigger(text)` → server `startLlmAndTts`(现成,内部 bargeIn)。mobile 端侧模式不再发 `session.start / audio.chunk / audio.end`。
- 限额:`chat.trigger` 已计入 chat_round 限额(`index.ts:95`)— OK,不动。
- 字幕:用户 ASR partial 改由 bridge `onAsrPartial` 来(不再 server `asr.partial`)→ web 直接 `setSubtitle(partial)`。
- ⚠️ **反馈库(captureMode='feedback')**:现状 server 把孩子 ASR 转写落反馈库;端侧 ASR 后,孩子文本在端侧产生 → 需随 final 把文本 + captureMode 带给 server 落库(设计点 ④:复用 `chat.trigger` 时如何携带 captureMode / 是否新增 `asr.text` 消息类型显式区分孩子真实语音 vs 开场白 trigger)。这条要确认 server 反馈链路,别丢了吐槽采集。

---

## 8. 模式开关与回退(SpeechEngine 抽象,docs/31 §8 折中)

- 原生壳 + `isOnDeviceAsrAvailable()` → **端侧 Zipformer ASR**。
- 纯浏览器 / 原生 ASR 不可用 / 模型加载失败 → **回退云火山**(现状链路零改)。
- web 侧 `voice-client` 把"ASR 来源"抽象成 `native-bridge | server-volc` 两个 provider,`useMobileVoice` 与 UI 层对来源无感,只消费 partial/final/endpoint 三事件(不论来自 bridge 还是 ws)。

---

## 9. 真机实测清单(交付门)

1. **童声 CER**:type 9 vs type 20 对比,5-10 岁样本,记 CER + 意图命中率 + 端点截断率 + final 延迟(川哥说不强求精度,但建议测以定模型)。
2. **判停**:auto 模式 endpoint 延迟、截断率(童声拖音/句间停顿不被误切)。
3. **AEC**:TTS 播放↔ASR 静音切换时序,确认无自激、无切换边界漏字/吞首字。
4. **唤醒→ASR gap**:KWS 命中切 ASR 的衔接延迟(目标无感)。
5. **内存/温升**:中端机单 ASR 模型 + WebView 常驻内存(弃 SenseVoice 后无双跑)、连续 15min 会话降频。
6. **PTT 与 auto 双模式** + 多轮 followup + 打断回归。

---

## 10. 分阶段 + 分工(team)

| 阶段 | 内容 | 引擎 |
|---|---|---|
| P0 | 选定模型 type + 下载落 assets + 单测 OnlineRecognizer 能跑(验 .so 含 ASR) | cc + 真机 |
| P1 | `AsrBridge.kt` / `AudioEngine`(KWS+ASR 复用单 AudioRecord)原生实现 | grok + codex 双发(code-2send) |
| P2 | `bridge.ts` 协议扩展 + `voice-client` ASR provider 抽象 + `useMobileVoice` 接 bridge 事件 | cc(Web 主场) |
| P3 | 判停童声调参 + AEC 时序联调 + 字幕/反馈库链路 | cc + 真机 |
| P4 | 真机实测(§9)+ 童声调参定模型 | 川哥 |

---

## ★ 待 team 评审的开放决策(请四家攻击/补全)

1. **模型起点**:type 9(zh-14M)vs type 20(zh-int8-2025)—— 哪个做打通起点?童声 CER/体积/延迟权衡。
2. **麦克风衔接**:KWS↔ASR 复用同一 AudioRecord(无 gap,复杂,要状态机)vs 释放重开(简单,有切换 gap)?
3. **判停起点值**:童声 rule2 minTrailingSilence 该取多少(别照搬 docs/31 的 0.3s)?
4. **server 协议**:复用 `chat.trigger` vs 新增 `asr.text`?captureMode(反馈库)怎么随端侧 final 带上不丢?
5. **原生结构**:`AsrBridge` 独立 vs 把 KWS+ASR 合并成单一 `AudioEngine`(管唯一 AudioRecord)?
6. **遗漏/风险**:本方案有没有漏掉的 on-device 致命坑(音频会话冲突 / WebView TTS 路由 / 中端机 OOM / 切换竞态 / 端侧 partial 喂字幕的节流)?

---

## 11. ★ team 四发评审收敛(v0.2 · 2026-06-21 · 权威)

> 四发:grok-4.3 / codex gpt-5.5 / gemini-3-flash / antigravity gemini-3.5-flash(只读沙箱)。**一致结论:方案方向正确,但不能直接进 P1 写码,必须先收敛下列阻塞项。** 原始 [`_doc32-asr/round1/`](_doc32-asr/round1/)。

### A. 四家共识 · 阻塞性(最高置信,必修)

| # | finding | 修正设计 |
|---|---|---|
| A1 | **必须合并单一 `AudioEngine`**(KWS+ASR 共用一个常驻 `AudioRecord`) | 释放/重开 AudioRecord 有 100–500ms 硬件 warmup gap → 唤醒后孩子**首字必被截断**。原生只维护**一个常驻 AudioRecord**,按状态把 16k PCM 帧分发给 KeywordSpotter 流 或 OnlineRecognizer 流;`AsrBridge`/`WakeWordBridge` 都退化成薄 JS 门面,音频状态机收进 `AudioEngine`。**否决"释放重开"。**(开放决策 ②⑤ 定案) |
| A2 | **KWS→ASR 要 pre-roll / ring buffer** | KWS 命中在唤醒词结束后,孩子常紧接正文;命中后才建 ASR stream 会吞首 300–800ms。`AudioEngine` 维护 ~800ms PCM 环形缓冲,命中后把"命中尾部 + 最近上下文帧"回灌给新 `OnlineStream` 再进 ASR 态(回溯式启动)。**cc v0.1 漏项。** |
| A3 | **不能裸复用 `chat.trigger`;新增 `asr.text` + 反馈库原声补传** | ① `chat.trigger` 语义混(开场白/手输/真实语音);新增 `asr.text{text,captureMode,utteranceId,source,mode,isFinal}`,server 内部仍复用 LLM→TTS。② **更严重:端侧 ASR 后 server 收不到 PCM → 反馈库(captureMode='feedback')的孩子原声资产丢失**(童声坏例/后续微调样本废掉)→ captureMode 开启时原生把本轮对话压缩音频(Opus/WAV)异步补传 server 关联文本。**cc v0.1 盲点(只想到带 captureMode 标记,漏了原声音频)。** |
| A4 | **AEC 物理静音的 JS→原生时序不可靠 → 播放前置确认屏障 + 尾部保护窗** | JS Bridge 异步 50–120ms:TTS 已出声但 ASR 未静音 → 录到自声首字节自激;恢复时吞用户抢答首字。修:① Web 在**发起 TTS 请求**(非播放事件)时即 `notifyTtsState(true)`;② Web 等原生 ack「ASR 写入已挂起」再正式播 TTS(前置屏障);③ 恢复加 150–300ms 延迟 + 尾部能量 VAD 滤功放余振。**cc v0.1 只说复用时序点,无 ack。** |
| A5 | **端侧 partial 喂字幕必须节流** | Zipformer decode 帧 ~50–100ms 一次,裸推 `evaluateJavascript` 压垮 WebView 主线程(卡顿/字幕闪)。原生侧节流 ≥100–150ms + 文本变化才推 + `onAsrFinal` 不节流。 |
| A6 | **P0 硬门槛:真机首验(写码前置)** | ① 同进程先后实例化 `KeywordSpotter`+`OnlineRecognizer`、单路 PCM 切换、连续 15min 无 crash/OOM(验单 `.so` 真含 ASR 能力);② type 9 vs type 20 用 5–10 岁童声样本跑 CER + 首 token 延迟 + RTF + 峰值 RSS + APK 增量。**.so 不支持 ASR 则整方案换 sherpa 包,代码白写 → 必须先验。** |

### B. 多家共识 · 必修

- **B1 音频会话路由**(grok+codex+gemini):显式管 `AudioManager` mode/route;⚠️ **gemini 关键纠正——硬件 `AcousticEchoCanceler` 通常只在 `VOICE_COMMUNICATION` 通话模式 + 喇叭走通话声道才生效,而 WebView TTS 走 `STREAM_MUSIC`,硬件 AEC 对它完全不起作用**。这跟现状 `WakeWordBridge.kt` 注释"用 AcousticEchoCanceler 抑制 TTS 自声"**矛盾**(现状很可能没真生效,只是 KWS 匹配特定词误触发率低掩盖了)→ ASR 自声抑制**只能靠 A4 物理丢帧,不能指望硬件 AEC**。首版支持矩阵优先外放/有线/A2DP,异常 route 降级云。
- **B2 provider 互斥防双 ASR**(codex+gemini35):端侧初始化慢/失败时 web 可能已 `getUserMedia`,原生又持麦 → 权限争抢/重复 final/重复扣限额。一会话只允许一个 active `asrProvider`(native-bridge | server-volc),切换显式 stop/ack 交割麦克风句柄。
- **B3 低端机 OOM 防护**(gemini35+gemini):儿童设备常 2–3G RAM,WebView+KWS+ASR 易被强杀。初始化查 `ActivityManager.MemoryInfo`,低于安全线(~400MB)强制 `isOnDeviceAsrAvailable()=false` 优雅回退云。

### C. 6 个开放决策 · 裁决

| 决策 | 裁决(四家收敛) |
|---|---|
| ① 模型起点 | type 9(14M)做 JNI 打通起点,**但 P0 必须用童声样本 CER 对比 type 20;若 type 20 显著更优(CER↓≥15%)且内存增量可接受 → type 20 进版**。保留一键切换。 |
| ② 麦克风衔接 | **单 `AudioRecord` + `AudioEngine` + ring buffer**,否决释放重开。 |
| ③ 童声判停 rule2 起点 | 0.3s 太激进(四家否)、1.5s 太迟钝(gemini:+LLM/TTS 空窗>3s 丧失实时感)→ **起点 ~1.0s,且做成 Web 可动态下发**(按真机截断率↔空窗感双向热调);`onAsrEndpoint` 只作"停录音"信号,**等 final 文本稳定再入 LLM**(partial 会回改)。 |
| ④ server 协议 | **新增 `asr.text`(不裸用 chat.trigger)+ captureMode 反馈原声异步补传**(见 A3)。 |
| ⑤ 原生结构 | **单一 `AudioEngine`** 持麦 + 分发;`AsrBridge`/`WakeWordBridge` 仅薄 JS 门面。 |
| ⑥ 遗漏坑 | pre-roll(A2)/ TTS 时序 ack(A4)/ partial 节流(A5)/ 音频路由+硬件 AEC 失效(B1)/ 双 provider 互斥(B2)/ OOM(B3)/ APK 体积分发(下条)。 |

### D. cc v0.1 盲点(诚实留痕)
1. **反馈库原声丢失**(A3 第②点):只想到带 captureMode 标记,漏了端侧 ASR 后 server 没有 PCM、孩子原声资产没了。
2. **AEC 时序屏障**(A4):只说"复用 onTtsAudio/onPlaybackEnd 时序点",没设计 JS→原生异步延迟的前置 ack。
3. **pre-roll/ring buffer**(A2):没写唤醒→ASR 衔接的首字回溯。
4. **partial 节流**(A5)、**硬件 AEC 对 STREAM_MUSIC 失效**(B1)未覆盖。

### E. 其他优化(P1 后迭代)
- **APK 体积**:模型打进 APK 显著膨胀 → P0 量化;超阈值考虑 Play Asset Delivery / 首启 Wi-Fi 下载 + 模型缺失回退云(已与 B3 回退路径合流)。
- **中期可选**:TTS 播放也收敛到原生,让原生持有权威 playback lifecycle(A4 的彻底版),P1 先用前置屏障+保护窗。

### F. 修正后的下一步(P0 = 写码门槛,需真机)
1. **P0(真机,需川哥)**:下载 type 9 + type 20 落 assets(量体积)→ 最小 smoke:同进程 KWS+OnlineRecognizer 跑通 + 15min 无 OOM + type9/20 童声 CER/RTF/RSS 对比。**.so 验真 + 模型选定后才进 P1。**
2. **P1**:`AudioEngine`(单 AudioRecord + ring buffer + KWS/ASR/TTS-gating 状态机)+ `AsrBridge` 薄门面 —— `code-2send` 双发(grok+codex)。
3. **P2**:`bridge.ts` 扩 `asr.text` 协议 + `voice-client` provider 抽象 + provider 互斥 + 反馈原声补传 —— cc。
4. **P3**:判停热调 + AEC 前置屏障/保护窗联调 + partial 节流 —— cc + 真机。

---

## 12. P0 执行记录(cc · 2026-06-21)

### 实测候选体积(已下载核实,非文档估值)
| type | 模型 | 架构 | 真入 APK | 手机端 |
|---|---|---|---|---|
| 9 | zh-14M-2023-02-23 | transducer | **~30MB**(enc.int8 21.6 + dec 7.5 + join.int8 1.8) | ✅ 候选 |
| 15 | small-ctc-zh-int8-2025-04-01 | CTC | **~25MB**(model.int8 26.3) | ✅ 候选 |
| 16 | small-ctc-zh-2025-04 | CTC float | 包 83MB | ❌ 偏大 |
| 17 | ctc-zh-int8-2025-06 | CTC | 包 122MB | ❌ 偏大 |
| 18 | ctc-zh-2025-06 | CTC float | 包 562MB | ❌ |
| 20 | zh-int8-2025-06-30 | transducer | enc.int8 **161MB** | ❌ 服务器级,出局 |

**选型修正(实测推翻 docs/31 + 本文 v0.1 设定)**:① "Zipformer-zh 14MB" 实为**参数量**,type9 真入 APK ~30MB;② v0.1 设的 "type9 vs type20" 对比**作废**——type20 是 161MB 服务器级模型,手机端出局;真正候选是 **type9(transducer 2023)vs type15(small-ctc 2025)**,体积同量级(25–30MB),CER 真机定。`.so` 复用零增量(libonnxruntime 25.8MB 已在 APK)。

### cc 已交付(可直接编译,Gate2 Guard 已过)
- `apps/android-shell/scripts/download-asr-models.sh`:下载 type9/15 + 列真实文件结构 + 量体积(已修 macOS bash 3.2 兼容)。
- 模型挑入 `assets/asr-model-v9/`(transducer 三件套)+ `asr-model-v15/`(ctc 单文件)+ `asr-test.wav`(16k mono);`.gitignore` 忽略防 55MB 进 git。
- `AsrSmokeTest.kt` + MainActivity `if (BuildConfig.DEBUG)` 调用:验 ① 单 `.so` 跑 `OnlineRecognizer` ② KWS+ASR 同进程共存 ③ type9/15 识别文本/RTF/耗时/内存。
- ✅ **`./gradlew assembleDebug` BUILD SUCCESSFUL(14s)**;产 `app-debug.apk` **102MB**(含双候选模型,选定后减半 ~75MB)。

### 真机验证结果 ✅ P0 通过(三星 S24 Ultra / SM-S9280,2026-06-21)
`adb install` + 启动 + `logcat AsrSmoke` 实测:

| 项 | 结果 |
|---|---|
| 单 `.so` 跑 `OnlineRecognizer` | ✅ type9 + type15 均 init+decode 成功(**.so 含 ASR 由"推断"转已验证**) |
| KWS+ASR 同进程共存 | ✅ init 成功(P1 单 `.so` 复用前提坐实) |
| type9 transducer | init 871ms / decode 197ms / **RTF 0.035** /「对我做了介绍那么我想说的是大家如果对我的研究感兴趣」 |
| type15 small-ctc 2025 | init 882ms / decode 139ms / **RTF 0.025** /「…那么我想说的是呢…对我的研究感兴趣呢」 |
| 内存(native) | 基线 38M → type9 99M → type15 116M → KWS+ASR 双实例 118M → release 后 47M |

测试音频 = sherpa 自带成人中文 5.61s,两模型识别都正确(type15 略快、略多语气词)。⚠️ **旗舰机数据**:RTF 极低无延迟忧,但中端机(2–3G RAM)RTF×几倍 + native ~100MB + WebView 内存需另测 OOM。

### 剩余(定最终模型 + 进 P1)
1. **童声 CER(决定性)**:成人音频两模型都准、分不出高下;需真实 5–10 岁童声样本(16k mono wav 换 `asr-test.wav` 重测)才能定 type9 vs type15。初步倾向 type15(更小 25MB + 略快 + 2025 新)。
2. **中端机实测**:旗舰不代表,找一台中端 Android 验内存/温升/RTF。
3. **P1**:`code-2send` 双发 `AudioEngine`(单 AudioRecord + ring buffer + KWS/ASR/TTS-gating 状态机)——架构与具体模型解耦,可先用 type15 起。

---

## 13. P1 执行记录(cc + team 双发 · 2026-06-21)

- **code-2send 双发**:grok-build(agentic 直接落地 repo)+ codex gpt-5.5(903 行方案文本)。
- **cc 综合落地**:以 grok 集成骨架为基(MainActivity 注入 / AsrBridge 门面 / WakeWordBridge 委托),合入 codex 的并发严谨性——给 `currentAsrStream` 跨线程访问加 `asrLock` 互斥(修 Bridge 线程 release ↔ 录音线程 decode 的 **use-after-release 竞态**)+ 修 stopAsr 笔误 + notifyTtsState 恢复态 + onNativeReady 带 onDeviceAsrAvailable。
- **产出**(android-shell 原生,模型 type15):
  - `AudioEngine.kt`:单 AudioRecord + 状态机(IDLE/ASR/TTS_PLAYING)+ 800ms ring buffer pre-roll(防唤醒首字截断)+ TTS gating 物理丢帧 250ms 恢复(防自激)+ partial 120ms 节流 + auto/ptt 双模式 + 优雅降级 + `asrLock` 并发安全。
  - `AsrBridge.kt`:`KidshubNative` JS 门面。`WakeWordBridge.kt`:退化委托。`MainActivity.kt`:注入单一 KidshubNative + 生命周期转调。
- ✅ **`./gradlew assembleDebug` BUILD SUCCESSFUL**。⚠️ 教训:首版有 Kotlin if-表达式编译错(synchronized 把无-else 的 if 当返回值),且 `gradlew | tail` 退出码是 tail 的(恒 0)不可信 → 改用 gradlew 真实 RC + grep `BUILD SUCCESSFUL` 判定。
- 两家原始存 `_doc32-asr/round2-p1-codegen/`。**真机端到端待 P2**(原生层单独只能验编译 + init)。

### 下一步 P2(cc 写 Web 层)
`bridge.ts` 扩 ASR 协议 + `voice-client` ASR provider 抽象(native-bridge | server-volc)+ `useMobileVoice` 接 onAsrPartial/Final/Endpoint → final 走 `asr.text`(带 captureMode + 反馈原声补传)+ provider 互斥 + AEC 调 `notifyTtsState`。

---

## 14. P2(端侧 ASR Web 接入)+ AEC 自唤醒修复(cc + team 三发 · 2026-06-21)

### AEC 自唤醒(team 三发评审,原始存 `_doc32-asr/round3-aec/`)
P1 真机暴露:TTS 播放时 KWS 录到小可自声「小可」→ 自唤醒(gemini 上轮预言「硬件 AEC 对 WebView STREAM_MUSIC 不生效」印证)。三家共识:**TTS 期物理 gate KWS + 延迟恢复**。落地 `AudioEngine`:`notifyTtsState(true)` gate KWS;`(false)` 后 `KWS_RESUME_DELAY=400ms` 恢复(防扬声器尾音余振再自唤醒)。代价:TTS 期失「喊小可打断」→ PTT 兜底。后续可上 gemini 文本感知 gating(含「小可」句才 gate)保留 ~85% 语音打断。否决通话模式(毁音色)/ 软件 AEC(长期正解,非 demo)。

### P2 Web 端侧 ASR 接入(cc)
- `bridge.ts`:扩 NativeBridge(isOnDeviceAsrAvailable/startAsr/stopAsr/notifyTtsState)+ WebBridge(onAsrPartial/Endpoint/Final);纯浏览器无 KidshubNative → 自动回退云火山。
- `useMobileVoice`:`useDeviceAsrRef` 分叉——beginTurn 用 `startAsr`(auto/ptt)替 getUserMedia、不 pauseWakeListening、不起 6s 窗;finishTurn/退出/打断用 `stopAsr`;`onAsrFinal` → `chat.trigger` 入 LLM(**server 零改**);onPlaybackEnd 端侧原生 auto 连续多轮(不走 Web followup);onTtsAudio/onPlaybackEnd 调 `notifyTtsState`(AEC)。
- captureMode 反馈原声补传(team A3):demo 阶段标 TODO。
- ✅ 验证:android `assembleDebug` + web `tsc --noEmit` + 完整 `build`(含 scope check)全 RC=0。

### 真机 E2E 待(部署含 P2 的 web → App 加载)
测:唤醒 →端侧识别(逐字字幕)→ endpoint → chat.trigger → LLM → TTS → **小可说话不自唤醒**(gate KWS)→ 多轮 → PTT 打断。
