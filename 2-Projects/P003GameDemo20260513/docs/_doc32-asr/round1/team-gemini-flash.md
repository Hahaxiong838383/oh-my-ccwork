# 「小可本地 ASR 集成实施方案」对抗评审报告

---

### 一、 阻塞性风险（必须修改才能开干）

#### 1. 【问题】麦克风物理释放/重开产生切换时延与丢字漏字
* **为什么是问题**：若 KWS 与 ASR 采用“释放旧 AudioRecord，重新创建新 AudioRecord”的解耦方案，Android 系统的 `AudioRecord.stop()` 和 `release()` 伴随 IPC 绑定销毁，重新 `startRecording()` 至硬件缓冲区填充就绪，累计耗时通常在 **150ms~300ms**。此时，儿童在唤醒后立刻说出的首个单词（如唤醒后紧跟“我想听...”中的“我”）必定被硬件漏录，导致端侧 ASR 首字识别率暴跌。
* **建议修法**：**必须合并为单一 `AudioEngine`。** 原生层仅维护一个常驻的 `AudioRecord` 实例。通过内部轻量状态机分配 PCM 帧流向：
  * **唤醒态**：PCM 帧仅送入 `KeywordSpotter` 环形缓冲。
  * **识别态**：无缝切换将 PCM 帧送入 `OnlineRecognizer` 的 `OnlineStream`，完全避免硬件重置。

#### 2. 【问题】端侧本地 ASR 导致云端「反馈库音频采集（captureMode）」失效
* **为什么是问题**：现有方案试图直接复用 `chat.trigger(text)` 将 ASR 识别后的文本发给服务器。但在 `captureMode='feedback'`（吐槽/负反馈分析）场景下，服务器原先依赖 Web 端上传的 PCM 音频流来保存孩子的声音样本。若采用端侧 ASR 且只发文本，云端将彻底失去物理语音资产，无法回溯童声识别坏例并进行后续声学模型微调。
* **建议修法**：
  1. 不能单纯复用 `chat.trigger`。必须扩展协议，或者引入 `asr.text` 帧，携带 ASR 识别结果及端侧临时录音的标识。
  2. 原生 `AudioEngine` 在 ASR 开启期间，应在内存或私有缓存目录中循环保留最后一次对话的压缩音频段（如用 Ogg/Opus 编码以节省空间）。
  3. 当触发需要上传反馈的机制时，由客户端异步上传该音频段，确保反馈库链路完整。

#### 3. 【问题】JS Bridge 高频调用导致 WebView 渲染与主线程卡顿
* **为什么是问题**：流式 Zipformer ASR 产生的 partial 结果回调极快（每 60ms-100ms 产生一次增量文本）。如果原生层不加限制地通过 `evaluateJavascript` 往 WebView 频繁推送 `onAsrPartial`，Android Bridge 会因为频繁的 IPC 和 JS 线程排队导致系统 UI 出现明显的掉帧、卡顿，甚至阻塞 Web 端的语音波形动画。
* **建议修法**：在 `AsrBridge.kt` 内部对 `onAsrPartial` 增加**时间节流（Throttling）机制**。至少保证推送间隔 $\ge 150\text{ms}$，且只有当 `text` 字符发生实际变化时才通过 Bridge 发送。最后一次的 `onAsrFinal` 必须不受节流限制，立即发送。

#### 4. 【问题】JNI 内存泄漏与 OnnxRuntime 实例常驻导致的 OOM 风险
* **为什么是问题**：方案假定单一 `libsherpa-onnx-jni.so` 可安全并发运行。实际上，`OnlineRecognizer` 和 `KeywordSpotter` 分别加载不同的 ONNX 模型（ASR 模型通常较大）。如果在多轮对话切换中频繁销毁重建 `OnlineStream` 或 `OnlineRecognizer`，ONNX Runtime 的 C++ 堆内存不会立即被 JVM 垃圾回收，极易造成端侧内存碎块化乃至 native OOM。
* **建议修法**：
  1. 将 `OnlineRecognizer` 和 `KeywordSpotter` 在原生层设计为常驻单例，禁止在会话期间销毁重建。
  2. 每次多轮对话结束时，仅对 `OnlineStream` 执行 `reset(stream)`，重置模型内部的状态矩阵（state tensors），而非销毁实例。
  3. 退出语音模式（如进入纯文本界面）时，必须显式调用各自的 `release()` 或 `close()` 方法释放 C++ 侧的内存指针。

---

### 二、 优化与健壮性建议（可迭代）

#### 5. 【问题】物理静音机制存在异步时间差，极易引起首字吞没或自激残留
* **为什么是问题**：方案设计通过 Web 端 `onTtsAudio` 触发 `notifyTtsState(true)` 物理静音原生 ASR。由于 JS 到原生的 Bridge 通信存在 **50ms~120ms** 的延迟，当 WebView 开始播放 TTS 声波时，原生麦克风可能还没来得及静音，导致 TTS 首字节泄露给 ASR，产生假转写；同理，TTS 播放完毕后恢复 ASR 录音时，若延迟未同步，会吞掉孩子急于插话的首字。
* **建议修法**：
  * **提前占位**：在 Web 发起 TTS 请求（而非收到音频播放事件）时，提前向原生发送 `notifyTtsState(true)`。
  * **尾部延时**：在 `notifyTtsState(false)` 恢复录音时，原生端对获取的 PCM 帧音频能量进行快速 VAD 校验，过滤掉因 TTS 硬件功放物理余振产生的噪声。

#### 6. 【问题】判停参数（rule2）直接设置 1.2s-1.5s 会导致严重的交互迟钝感
* **为什么是问题**：docs/31 提出的 0.3s 对童声确实太激进（儿童易口吃停顿）；但方案提出的 1.2s-1.5s 过于保守。1.5s 的端侧判停 + LLM 首包延迟（约 1s） + TTS 流式下发（约 0.5s），会使孩子说话后等待小可回应的物理空窗期达到 **3 秒以上**，基本丧失实时陪伴感。
* **建议修法**：
  * 将 `rule2`（有内容后的静音判停）初始值设为 **0.8s ~ 1.0s**。
  * 配合 `rule3`（最大语音长度限制）缩短至 **15s**，防止儿童因持续环境杂音导致 ASR 无法收尾。
  * 针对 PTT 模式，在松手时直接强制触发 final，彻底跳过 endpoint 检测。

#### 7. 【问题】童声下 14M 极小模型（Type 9）的 CER 准确率隐患
* **为什么是问题**：Type 9 (2023版 14M) 的声学建模能力极弱，对发音含糊、声调尖锐、吐字断续的儿童语音识别率极差。虽然其体积小，但在非理想环境下可能导致小可频繁“听不懂”，严重影响核心体验。而 Type 20 (2025版 int8) 结合了更新的神经网络架构，在牺牲几兆内存的前提下，CER 表现通常有质的提升。
* **建议修法**：
  * **P0 阶段并行对比**：在 P0 阶段，不仅单测能跑，必须用儿童录音样本（5-10岁）对 Type 9 和 Type 20 进行 CER 离线对比。
  * 如果 Type 20 的 CER 显著优于 Type 9（例如 CER 降低 15% 以上），且中端机内存增量在 30MB 以内，**应果断以 Type 20 作为 baseline 进版**。

#### 8. 【问题】Android AudioRecord 硬件 AEC 无法覆盖 WebView TTS 播放的音频
* **为什么是问题**：方案寄希望于 `AcousticEchoCanceler` 抑声。然而，Android 系统的硬件 AEC 通常仅在 `VOICE_COMMUNICATION`（通话模式）录音源，并且系统喇叭播放同样路由在通话声道时才生效。而 WebView 播放 TTS 走的是 `STREAM_MUSIC`，硬件 AEC 对此完全不起作用。
* **建议修法**：必须明确放弃对系统底层 AEC 滤除 TTS 自声的幻想。强化方案 §6 中的物理丢帧逻辑，即在 `notifyTtsState(true)` 期间，原生 `AudioEngine` 必须将收到的 PCM 帧直接丢弃，不向 `OnlineStream` 写入任何字节。

---

### 三、 评审总评与结论

**结论**：**不能直接进入 P1 写码。必须先修改并收敛以下 3 个关键点：**
1. **统一 `AudioEngine` 架构设计**：细化 KWS 与 ASR 在单个 `AudioRecord` 下的 PCM 分发与指针重置逻辑，规避重开麦克风造成的时延。
2. **重构端侧反馈（Feedback）上传链路**：明确端侧 ASR 文本模式下，如何离线缓存并按需上传 PCM 音频给服务器以保留吐槽样本。
3. **完成 Type 9 与 Type 20 模型的 CER 快速真机对比**：以数据支撑模型最终选型，防范上线后因识别率低导致退货率飙升。

上述阻塞点明确并落实到设计方案后，方可启动 native 编码。

署名：gemini（Google）
