# 评审任务:小可「本地 Zipformer-zh ASR 集成实施方案」对抗评审(team 四发顶级)

## 你的角色与边界
你在评审一份**工程实施方案草稿**(下方 docs/32)。这是一个**儿童语音陪伴 App「小可」**的手机端:现有一个 **Android 原生薄壳(WebView)+ Web 核心**架构,要把语音识别(ASR)从「云火山流式 ASR」改成「端侧 sherpa-onnx 流式 Zipformer-zh」。

## ⚠️ 不要重新论战这些(已由上一轮 team 四发 + 川哥拍板锁定,再争=浪费产出)
- 用 on-device 还是 self-hosted/云 → **已定 on-device 本地 ASR**(动机:隐私不出端 + 手机端壁垒)。
- Zipformer 还是 SenseVoice → **已定 Zipformer,弃 SenseVoice**(情绪识别儿童误判率高、无逐字 partial、双跑 OOM)。
- TTS、LLM、情绪 → **已定**云豆包 TTS(保小可音色)/ 云 LLM / 情绪走云 LLM 文本推断。
请把火力**全部集中在「这份实施方案本身对不对、够不够深、有没有漏致命坑」**。

## 你要攻击的点(逐条给结论 + 修法)
1. **6 个开放决策**(方案末尾★列出):模型 type 9 vs 20、KWS↔ASR 麦克风衔接、童声判停起点值、server 协议(chat.trigger 复用 vs 新增 asr.text + 反馈库 captureMode 怎么不丢)、原生结构(AsrBridge 独立 vs 合并 AudioEngine)、遗漏的致命坑。逐条给你的判断和理由。
2. **方案声称的仓库事实**(你看不到源码,凭工程常识判合理性):单一 `libsherpa-onnx-jni.so` 真能同时跑 KeywordSpotter 和 OnlineRecognizer 吗?`chat.trigger` 复用绕开 server ASR 这条路有没有隐患?「对话期麦克风从 Web getUserMedia 翻转给原生持有」的竞态/时序安全吗?
3. **AEC 自激**(§6):TTS 在 WebView 播、原生 ASR 持麦,物理静音方案够不够?切换边界会不会吞首字/漏字?KWS 打断与 ASR 静音并存会不会冲突?
4. **判停**(§5):童声 endpointing 调参方向对不对?方案说 docs/31 的 0.3s 太激进、起点取 1.2-1.5s,认同吗?
5. **没列出的风险**:Android 音频会话(AudioRecord source/通话模式)冲突、WebView TTS 输出路由、中端机内存/降频、端侧 partial 高频喂字幕的节流、模型 assets 打进 APK 的体积膨胀、唤醒→ASR 切换 gap。

## 输出要求
- 按严重度排序的 finding 列表,每条:【问题】+【为什么是问题】+【建议修法】。
- 明确区分「阻塞性(必须改才能开干)」vs「优化项(可迭代)」。
- 末尾给一句话总评:这方案能不能直接进 P1 写码,还是必须先改哪几条。

---

（以下是待评审的实施方案 docs/32 全文）

# docs/32 · 小可本地 ASR(Zipformer-zh)集成实施方案

> 选型已锁(见 [docs/31 §12](31-端侧语音ASR-TTS开源选型评审报告-team四发.md)):**本地 sherpa-onnx + 流式 Zipformer-zh 听 → 云 LLM 想 → 云豆包 TTS 说**,情绪走云 LLM 文本推断,判停用 Zipformer 自带 endpointing,AEC 靠原生层 TTS 播放时静音 ASR。本文是把这条已锁链路落到工程的实施方案。
>
> 状态:草稿 v0.1(cc 起草,基于真实源码复盘)→ 待 team 四发对抗评审收敛 → 定稿后分工写码。日期 2026-06-20。

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
